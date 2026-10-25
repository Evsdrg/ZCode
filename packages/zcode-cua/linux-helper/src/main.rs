// Linux Computer Use broker Helper
//
// 监听 unix socket，按 zcode CUA broker NDJSON 协议应答：
//   首帧 {"id":0,"method":"authenticate","params":{...}} -> {"id":0,"ok":true}
//   业务 {"id":N,"method":"<m>","params":{...}}          -> {"id":N,"ok":true,"result":..}
//
// 能力分两层：
//  1) 只读 + 元素级 a11y 动作（纯 AT-SPI，零授权）：
//     list_applications / capture_app / list_windows / application_info /
//     element_at_point / element_perform_action / element_set_value / element_select_text
//  2) 坐标级输入注入（xdg-desktop-portal RemoteDesktop，需授权）：click/scroll/drag/type(全局)/key/paste
//     —— 当前 fail-closed 返回 action_unavailable，待阶段 4 接 portal。
//
// native token 约定：`<bus_name>|<object_path>`（AT-SPI 对象在 a11y bus 上唯一定位），
// 由 capture_app 填入每个 element 的 native 字段，供 element_* 动作方法反查对象。

use atspi::connection::AccessibilityConnection;
use atspi::proxy::accessible::AccessibleProxy;
use atspi::proxy::action::ActionProxy;
use atspi::proxy::component::ComponentProxy;
use atspi::proxy::editable_text::EditableTextProxy;
use atspi::proxy::text::TextProxy;
use atspi::proxy::value::ValueProxy;
use atspi::CoordType;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::Path;

const DEFAULT_DEPTH: usize = 12;
const MAX_ELEMENTS: usize = 4000;

type Conn = atspi::zbus::Connection;

#[derive(Clone)]
struct App {
    bname: String,
    path: String,
    name: String,
    pid: i64,
}

async fn acc<'a>(conn: &'a Conn, name: &str, path: &str) -> Result<AccessibleProxy<'a>, String> {
    AccessibleProxy::builder(conn)
        .cache_properties(atspi::zbus::proxy::CacheProperties::No)
        .destination(name.to_string())
        .map_err(|e| e.to_string())?
        .path(path.to_string())
        .map_err(|e| e.to_string())?
        .build()
        .await
        .map_err(|e| e.to_string())
}

async fn get_pid(conn: &Conn, bname: &str) -> Option<i64> {
    let bn: atspi::zbus::names::BusName = bname.to_string().try_into().ok()?;
    let dbus = atspi::zbus::fdo::DBusProxy::new(conn).await.ok()?;
    match dbus.get_connection_unix_process_id(bn).await {
        Ok(pid) => Some(pid as i64),
        Err(_) => None,
    }
}

async fn list_apps(ac: &AccessibilityConnection) -> Result<Vec<App>, String> {
    let conn = ac.connection();
    let root = ac
        .root_accessible_on_registry()
        .await
        .map_err(|e| e.to_string())?;
    let kids = root.get_children().await.map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for k in kids {
        let bname = k.name().map(|n| n.to_string()).unwrap_or_default();
        let path = k.path().to_string();
        if bname.is_empty() {
            continue;
        }
        let pid = get_pid(conn, &bname).await.unwrap_or(-1);
        let ap = match acc(conn, &bname, &path).await {
            Ok(a) => a,
            Err(_) => continue,
        };
        let name = ap.name().await.unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let cc = ap.child_count().await.unwrap_or(0);
        if cc <= 0 {
            continue;
        }
        out.push(App {
            bname,
            path,
            name,
            pid,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

async fn get_actions(conn: &Conn, bname: &str, path: &str) -> Vec<String> {
    let b = match ActionProxy::builder(conn)
        .cache_properties(atspi::zbus::proxy::CacheProperties::No)
        .destination(bname.to_string())
    {
        Ok(b) => b,
        Err(_) => return vec![],
    };
    let b = match b.path(path.to_string()) {
        Ok(b) => b,
        Err(_) => return vec![],
    };
    let apx = match b.build().await {
        Ok(a) => a,
        Err(_) => return vec![],
    };
    apx.get_actions()
        .await
        .map(|v| v.into_iter().map(|a| a.name).collect())
        .unwrap_or_default()
}

async fn get_extents(conn: &Conn, bname: &str, path: &str) -> Option<(i32, i32, i32, i32)> {
    let b = ComponentProxy::builder(conn)
        .cache_properties(atspi::zbus::proxy::CacheProperties::No)
        .destination(bname.to_string())
        .ok()?;
    let b = b.path(path.to_string()).ok()?;
    let cp = b.build().await.ok()?;
    cp.get_extents(CoordType::Screen).await.ok()
}

/// 取文本/值接口能读到的当前值（用于 element.value 投影，尽力而为）。
async fn get_text_value(conn: &Conn, bname: &str, path: &str) -> Option<String> {
    // 先试 Value（数值控件），再试 Text/EditableText 的文本内容。
    if let Ok(b) = ValueProxy::builder(conn)
        .cache_properties(atspi::zbus::proxy::CacheProperties::No)
        .destination(bname.to_string())
        .and_then(|b| b.path(path.to_string()))
    {
        if let Ok(vp) = b.build().await {
            if let Ok(v) = vp.current_value().await {
                return Some(format!("{}", v));
            }
        }
    }
    None
}

fn native_token(bname: &str, path: &str) -> String {
    format!("{}|{}", bname, path)
}

fn parse_native(token: &str) -> Option<(String, String)> {
    let mut it = token.splitn(2, '|');
    let b = it.next()?.to_string();
    let p = it.next()?.to_string();
    if b.is_empty() || p.is_empty() {
        None
    } else {
        Some((b, p))
    }
}

struct WalkCtx {
    elements: Vec<Value>,
    lines: Vec<String>,
}

async fn walk(
    conn: &Conn,
    bname: &str,
    path: &str,
    depth: usize,
    owner_pid: i64,
    win_bounds: (i32, i32, i32, i32),
    ctx: &mut WalkCtx,
) {
    if ctx.elements.len() >= MAX_ELEMENTS {
        return;
    }
    let ap = match acc(conn, bname, path).await {
        Ok(a) => a,
        Err(_) => return,
    };
    let role = ap.get_role_name().await.unwrap_or_default();
    let name = ap.name().await.unwrap_or_default();
    let actions = get_actions(conn, bname, path).await;
    let ext = get_extents(conn, bname, path).await;
    let bounds = match ext {
        Some((x, y, w, h)) => json!([x, y, w, h]),
        None => json!([0, 0, 0, 0]),
    };
    let value = get_text_value(conn, bname, path).await;
    let lower = role.to_lowercase();
    let pressable = actions
        .iter()
        .any(|a| {
            let l = a.to_lowercase();
            l.contains("press") || l == "click" || l.contains("activate")
        });
    let has_menu = actions.iter().any(|a| a.to_lowercase().contains("menu"));
    let native = native_token(bname, path);
    ctx.elements.push(json!({
        "role": role,
        "kind": lower.clone(),
        "title": if name.is_empty() { Value::Null } else { Value::String(name.clone()) },
        "value": value,
        "bounds": bounds,
        "enabled": true,
        "editable": lower.contains("text") || lower.contains("entry") || lower.contains("edit"),
        "actions": actions,
        "focused": false,
        "default_action": pressable && !has_menu,
        "pressable": pressable,
        "has_menu": has_menu,
        "native": native,
        "owner_pid": owner_pid,
        "depth": depth as i64,
    }));
    let _ = win_bounds;
    ctx.lines.push(format!(
        "{}{}{}",
        "  ".repeat(depth),
        if lower.is_empty() {
            "element".to_string()
        } else {
            lower.clone()
        },
        if name.is_empty() {
            String::new()
        } else {
            format!(" {}", name)
        }
    ));
    if depth >= DEFAULT_DEPTH {
        return;
    }
    if let Ok(kids) = ap.get_children().await {
        for k in kids {
            let kn = k.name().map(|x| x.to_string()).unwrap_or_default();
            let kp = k.path().to_string();
            if kn.is_empty() {
                continue;
            }
            // 子元素 bus name 应与父相同；保守沿用父 bname（AT-SPI 树同属一个应用连接）
            let child_bname = if kn.is_empty() { bname } else { &kn };
            let _ = child_bname;
            let use_bname = k.name().map(|x| x.to_string()).unwrap_or_default();
            let use_bname = if use_bname.is_empty() {
                bname.to_string()
            } else {
                use_bname
            };
            Box::pin(walk(conn, &use_bname, &kp, depth + 1, owner_pid, win_bounds, ctx)).await;
        }
    }
}

fn find_app(apps: &[App], app_ref: &Value) -> Option<usize> {
    let pid = app_ref.get("pid").and_then(|v| v.as_i64());
    let name = app_ref.get("name").and_then(|v| v.as_str());
    let bundle = app_ref.get("bundle_id").and_then(|v| v.as_str());
    let mut hits: Vec<usize> = Vec::new();
    for (i, a) in apps.iter().enumerate() {
        if let Some(p) = pid {
            if a.pid == p {
                hits.push(i);
                continue;
            }
        }
        if let Some(n) = name {
            if a.name == n {
                hits.push(i);
            }
        }
        if let Some(b) = bundle {
            if a.name == b {
                hits.push(i);
            }
        }
    }
    hits.into_iter().next()
}

/// 找 app 的窗口（frame/window/dialog 子节点）标题与 bounds。
async fn find_window(conn: &Conn, app: &App) -> (Value, Value) {
    let mut wtitle = Value::Null;
    let mut wbounds = json!([0, 0, 0, 0]);
    if let Ok(ap) = acc(conn, &app.bname, &app.path).await {
        if let Ok(kids) = ap.get_children().await {
            for k in kids {
                let kn = k.name().map(|x| x.to_string()).unwrap_or_default();
                let kp = k.path().to_string();
                let bn = if kn.is_empty() { app.bname.clone() } else { kn };
                if let Ok(kap) = acc(conn, &bn, &kp).await {
                    let r = kap.get_role_name().await.unwrap_or_default().to_lowercase();
                    if r.contains("frame") || r.contains("window") || r.contains("dialog") {
                        let t = kap.name().await.unwrap_or_default();
                        if !t.is_empty() {
                            wtitle = Value::String(t);
                        }
                        if let Some((x, y, w, h)) = get_extents(conn, &bn, &kp).await {
                            wbounds = json!([x, y, w, h]);
                        }
                        break;
                    }
                }
            }
        }
    }
    (wtitle, wbounds)
}

async fn capture_app(
    ac: &AccessibilityConnection,
    apps: &[App],
    app_ref: &Value,
) -> Result<Value, String> {
    let conn = ac.connection();
    let i = find_app(apps, app_ref).ok_or_else(|| "app not found".to_string())?;
    let a = &apps[i];
    let (wtitle, wbounds) = find_window(conn, a).await;
    let wb = (
        wbounds[0].as_i64().unwrap_or(0) as i32,
        wbounds[1].as_i64().unwrap_or(0) as i32,
        wbounds[2].as_i64().unwrap_or(0) as i32,
        wbounds[3].as_i64().unwrap_or(0) as i32,
    );
    let mut ctx = WalkCtx {
        elements: Vec::new(),
        lines: Vec::new(),
    };
    walk(conn, &a.bname, &a.path, 0, a.pid, wb, &mut ctx).await;
    Ok(json!({
        "snapshot_mode": "full",
        "app": {
            "bundle_id": Value::Null, "pid": a.pid, "name": a.name,
            "aumid": Value::Null, "executable_path": Value::Null, "icon_png": Value::Null
        },
        "window": {"title": wtitle, "bounds": wbounds, "window_id": Value::Null},
        "elements": ctx.elements,
        "content": format!("App: {} (pid {})\n{}", a.name, a.pid, ctx.lines.join("\n")),
    }))
}

async fn list_windows(ac: &AccessibilityConnection, apps: &[App], app_ref: &Value) -> Value {
    let conn = ac.connection();
    let mut items = Vec::new();
    let targets: Vec<&App> = if let Some(idx) = find_app(apps, app_ref) {
        vec![&apps[idx]]
    } else {
        apps.iter().collect()
    };
    for a in targets {
        if let Ok(ap) = acc(conn, &a.bname, &a.path).await {
            if let Ok(kids) = ap.get_children().await {
                let mut index = 0;
                for k in kids {
                    let kn = k.name().map(|x| x.to_string()).unwrap_or_default();
                    let kp = k.path().to_string();
                    let bn = if kn.is_empty() { a.bname.clone() } else { kn };
                    if let Ok(kap) = acc(conn, &bn, &kp).await {
                        let r = kap.get_role_name().await.unwrap_or_default().to_lowercase();
                        if r.contains("frame") || r.contains("window") || r.contains("dialog") {
                            let t = kap.name().await.unwrap_or_default();
                            let b = get_extents(conn, &bn, &kp)
                                .await
                                .map(|(x, y, w, h)| json!([x, y, w, h]))
                                .unwrap_or(json!([0, 0, 0, 0]));
                            items.push(json!({
                                "index": index, "window_id": Value::Null, "title": t,
                                "bounds": b, "main": index == 0, "focused": false, "onscreen": true,
                                "pid": a.pid, "app_name": a.name,
                            }));
                            index += 1;
                        }
                    }
                }
            }
        }
    }
    json!({"ok": true, "result": {"items": items, "windows": items}})
}

async fn application_info(_ac: &AccessibilityConnection, apps: &[App], app_ref: &Value) -> Value {
    let i = match find_app(apps, app_ref) {
        Some(i) => i,
        None => return json!({"ok": false, "error": "app_not_found"}),
    };
    let a = &apps[i];
    json!({"ok": true, "result": {
        "bundle_id": Value::Null, "pid": a.pid, "name": a.name,
        "aumid": Value::Null, "executable_path": Value::Null, "icon_png": Value::Null
    }})
}

/// 元素级动作：按 native token 找对象，执行 AT-SPI 动作。
async fn element_perform_action(ac: &AccessibilityConnection, params: &Value) -> Value {
    let conn = ac.connection();
    let token = match params.get("native").and_then(|v| v.as_str()) {
        Some(t) => t,
        None => return fail("action_unavailable", "missing native token", false),
    };
    let action_req = params
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or("Press")
        .to_string();
    let (bname, path) = match parse_native(token) {
        Some(x) => x,
        None => return fail("action_unavailable", "invalid native token", false),
    };
    let b = match ActionProxy::builder(conn)
        .cache_properties(atspi::zbus::proxy::CacheProperties::No)
        .destination(bname.clone())
        .and_then(|b| b.path(path.clone()))
    {
        Ok(b) => b,
        Err(e) => return fail("action_unavailable", &format!("action proxy: {e}"), false),
    };
    let apx = match b.build().await {
        Ok(a) => a,
        Err(e) => return fail("action_unavailable", &format!("action build: {e}"), false),
    };
    let acts = match apx.get_actions().await {
        Ok(v) => v,
        Err(e) => return fail("action_unavailable", &format!("get_actions: {e}"), false),
    };
    // action 名归一：SDK 对 click 传 "AXPress"（macOS 命名），AT-SPI 实际是 "Press"。
    // 去掉 "AX" 前缀后再比对；同时保留原名匹配与外层容错。
    let want = normalize_action_name(&action_req);
    let mut idx: Option<i32> = None;
    for (i, a) in acts.iter().enumerate() {
        let n = normalize_action_name(&a.name);
        if n.eq_ignore_ascii_case(&want) || a.name.eq_ignore_ascii_case(&action_req) {
            idx = Some(i as i32);
            break;
        }
    }
    let idx = match idx {
        Some(i) => i,
        None => {
            let names: Vec<&str> = acts.iter().map(|a| a.name.as_str()).collect();
            return fail(
                "action_unavailable",
                &format!(
                    "action {:?} not available (native actions: {:?})",
                    action_req, names
                ),
                false,
            );
        }
    };
    match apx.do_action(idx).await {
        Ok(true) => json!({"ok": true, "result": {"action_sent": true, "dispatch_status": "accepted"}}),
        Ok(false) => fail("action_unavailable", "do_action returned false", false),
        Err(e) => fail("action_unavailable", &format!("do_action: {e}"), false),
    }
}

/// 设值：优先 EditableText.set_text_contents，其次 Value.set_current_value。
async fn element_set_value(ac: &AccessibilityConnection, params: &Value) -> Value {
    let conn = ac.connection();
    let token = match params.get("native").and_then(|v| v.as_str()) {
        Some(t) => t,
        None => return fail("not_settable", "missing native token", false),
    };
    let value = params
        .get("value")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| params.get("value").map(|v| v.to_string()))
        .unwrap_or_default();
    let (bname, path) = match parse_native(token) {
        Some(x) => x,
        None => return fail("not_settable", "invalid native token", false),
    };
    // 1) EditableText
    if let Ok(b) = EditableTextProxy::builder(conn)
        .cache_properties(atspi::zbus::proxy::CacheProperties::No)
        .destination(bname.clone())
        .and_then(|b| b.path(path.clone()))
    {
        if let Ok(et) = b.build().await {
            if let Ok(true) = et.set_text_contents(&value).await {
                return json!({"ok": true, "result": {"action_sent": true, "dispatch_status": "accepted"}});
            }
        }
    }
    // 2) Value（数值）
    if let Ok(b) = ValueProxy::builder(conn)
        .cache_properties(atspi::zbus::proxy::CacheProperties::No)
        .destination(bname.clone())
        .and_then(|b| b.path(path.clone()))
    {
        if let Ok(vp) = b.build().await {
            if let Ok(num) = value.trim().parse::<f64>() {
                if vp.set_current_value(num).await.is_ok() {
                    return json!({"ok": true, "result": {"action_sent": true, "dispatch_status": "accepted"}});
                }
            }
        }
    }
    fail("not_settable", "element has no settable EditableText/Value", false)
}

/// 选择文本：Text.set_selection。text_range = [start, end]。
async fn element_select_text(ac: &AccessibilityConnection, params: &Value) -> Value {
    let conn = ac.connection();
    let token = match params.get("native").and_then(|v| v.as_str()) {
        Some(t) => t,
        None => return fail("not_settable", "missing native token", false),
    };
    let (bname, path) = match parse_native(token) {
        Some(x) => x,
        None => return fail("not_settable", "invalid native token", false),
    };
    let (start, end) = match params.get("text_range").and_then(|v| v.as_array()) {
        Some(arr) if arr.len() == 2 => (
            arr[0].as_i64().unwrap_or(0) as i32,
            arr[1].as_i64().unwrap_or(0) as i32,
        ),
        _ => (0, 0),
    };
    let b = match TextProxy::builder(conn)
        .cache_properties(atspi::zbus::proxy::CacheProperties::No)
        .destination(bname.clone())
        .and_then(|b| b.path(path.clone()))
    {
        Ok(b) => b,
        Err(e) => return fail("not_settable", &format!("text proxy: {e}"), false),
    };
    let tp = match b.build().await {
        Ok(t) => t,
        Err(e) => return fail("not_settable", &format!("text build: {e}"), false),
    };
    match tp.set_selection(0, start, end).await {
        Ok(_) => json!({"ok": true, "result": {"action_sent": true, "dispatch_status": "accepted"}}),
        Err(e) => fail("not_settable", &format!("set_selection: {e}"), false),
    }
}

/// 命中测试：在各 app 的窗口元素上用 Component.GetAccessibleAtPoint 做原生命中
/// （O(depth)），命中即返回其 native token，owner_pid 用该 app 的 pid（可靠）。
async fn element_at_point(ac: &AccessibilityConnection, params: &Value) -> Value {
    let conn = ac.connection();
    let x = params.get("x").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
    let y = params.get("y").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
    let apps = match list_apps(ac).await {
        Ok(a) => a,
        Err(e) => return json!({"ok": false, "error": e}),
    };
    // 收集所有 app 的窗口 (面积, bname, path, pid)。AT-SPI GetAccessibleAtPoint 不感知
    // 窗口堆叠顺序（z-order），全屏窗口几何上会覆盖所有点；按面积升序试，让小窗口/真实
    // 应用先于全屏窗口被命中。
    let mut wins: Vec<(i64, String, String, i64)> = Vec::new();
    for a in &apps {
        let ap = match acc(conn, &a.bname, &a.path).await {
            Ok(v) => v,
            Err(_) => continue,
        };
        let kids = match ap.get_children().await {
            Ok(k) => k,
            Err(_) => continue,
        };
        for k in kids {
            let kn = k.name().map(|s| s.to_string()).unwrap_or_default();
            let kp = k.path().to_string();
            let bn = if kn.is_empty() { a.bname.clone() } else { kn };
            let kap = match acc(conn, &bn, &kp).await {
                Ok(v) => v,
                Err(_) => continue,
            };
            let role = kap.get_role_name().await.unwrap_or_default().to_lowercase();
            if !(role.contains("frame") || role.contains("window") || role.contains("dialog")) {
                continue;
            }
            let area = get_extents(conn, &bn, &kp)
                .await
                .map(|(_, _, w, h)| (w as i64) * (h as i64))
                .unwrap_or(0);
            wins.push((area, bn, kp, a.pid));
        }
    }
    wins.sort_by_key(|w| w.0);
    for (_area, bn, kp, pid) in wins {
        let cp = match ComponentProxy::builder(conn)
            .cache_properties(atspi::zbus::proxy::CacheProperties::No)
            .destination(bn.clone())
            .and_then(|b| b.path(kp.clone()))
        {
            Ok(b) => b.build().await.ok(),
            Err(_) => None,
        };
        if let Some(cp) = cp {
            if let Ok(obj) = cp.get_accessible_at_point(x, y, CoordType::Screen).await {
                let obn = obj.name().map(|n| n.to_string()).unwrap_or_default();
                let op = obj.path().to_string();
                if !obn.is_empty() && !op.is_empty() && op != "/org/a11y/atspi/null" {
                    return json!({"ok": true, "result": {
                        "native": native_token(&obn, &op), "owner_pid": pid
                    }});
                }
            }
        }
    }
    json!({"ok": true, "result": Value::Null})
}

fn normalize_action_name(name: &str) -> String {
    let n = name.trim();
    if let Some(rest) = n.strip_prefix("AX") {
        rest.to_string()
    } else {
        n.to_string()
    }
}

/// 统一的失败返回：action_unavailable/not_settable + action_sent=false + reason。
fn fail(code: &str, message: &str, action_sent: bool) -> Value {
    json!({"ok": false, "error": {
        "message": message, "code": code,
        "details": {"action_sent": action_sent, "reason": if action_sent { "sent" } else { "not_sent" }}
    }})
}

/// 坐标级输入注入尚未实现（需 portal）。fail-closed。
fn portal_unimplemented(method: &str) -> Value {
    fail(
        "action_unavailable",
        &format!("{method}: coordinate/global input injection requires xdg-desktop-portal RemoteDesktop, not yet implemented"),
        false,
    )
}

async fn dispatch(method: &str, params: &Value, ac: &AccessibilityConnection) -> Value {
    match method {
        "list_applications" => match list_apps(ac).await {
            Ok(apps) => {
                let arr: Vec<Value> = apps
                    .iter()
                    .map(|a| {
                        json!({
                            "name": a.name, "bundle_id": Value::Null, "pid": a.pid,
                            "active": false, "aumid": Value::Null
                        })
                    })
                    .collect();
                // SDK inventory 期望裸数组（或 {apps:[...]}）
                json!({"ok": true, "result": arr})
            }
            Err(e) => json!({"ok": false, "error": e}),
        },
        "capture_app" => {
            let app_ref = params.get("app_ref").cloned().unwrap_or(json!({}));
            match list_apps(ac).await {
                Ok(apps) => match capture_app(ac, &apps, &app_ref).await {
                    Ok(v) => json!({"ok": true, "result": v}),
                    Err(e) => json!({"ok": false, "error": e}),
                },
                Err(e) => json!({"ok": false, "error": e}),
            }
        }
        "list_windows" => match list_apps(ac).await {
            Ok(apps) => {
                let app_ref = params.get("app_ref").cloned().unwrap_or(json!({}));
                list_windows(ac, &apps, &app_ref).await
            }
            Err(e) => json!({"ok": false, "error": e}),
        },
        "application_info" => match list_apps(ac).await {
            Ok(apps) => {
                let app_ref = params.get("app_ref").cloned().unwrap_or(json!({}));
                application_info(ac, &apps, &app_ref).await
            }
            Err(e) => json!({"ok": false, "error": e}),
        },
        "element_at_point" => element_at_point(ac, params).await,
        "element_perform_action" => element_perform_action(ac, params).await,
        "element_set_value" => element_set_value(ac, params).await,
        "element_select_text" => element_select_text(ac, params).await,
        // 坐标/全局输入注入：待阶段 4 接 portal
        "click" | "scroll" | "element_scroll" | "drag" | "type" | "key" | "paste" | "hold_key"
        | "hold_key_to_app" | "screenshot" => portal_unimplemented(method),
        other => json!({"ok": false, "error": format!("method not implemented: {other}")}),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut socket_path = String::new();
    let mut i = 1;
    while i < args.len() {
        if args[i] == "--socket" && i + 1 < args.len() {
            socket_path = args[i + 1].clone();
            i += 2;
        } else {
            i += 1;
        }
    }
    if socket_path.is_empty() {
        eprintln!("usage: cua-linux-helper --socket <path>");
        std::process::exit(2);
    }
    let _ = std::fs::remove_file(&socket_path);
    if let Some(parent) = Path::new(&socket_path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let listener = UnixListener::bind(&socket_path).expect("bind socket failed");
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600));
    eprintln!("cua-linux-helper listening on {socket_path}");

    // 每连接一个线程 + 独立 current-thread runtime + 独立 a11y 连接：
    // 单线程串行 accept 会被一个长连接阻塞（node-repl-host 可能开多条连接），
    // 且 AccessibilityConnection 非 Send，不能跨线程共享。
    for stream in listener.incoming() {
        let stream = match stream {
            Ok(s) => s,
            Err(_) => continue,
        };
        std::thread::spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("runtime build failed: {e}");
                    return;
                }
            };
            rt.block_on(async move {
                let ac = match AccessibilityConnection::new().await {
                    Ok(a) => a,
                    Err(e) => {
                        eprintln!("cannot connect a11y bus: {e}");
                        return;
                    }
                };
                let _ = handle_conn(stream, ac).await;
            });
        });
    }
}

async fn handle_conn(
    stream: std::os::unix::net::UnixStream,
    ac: AccessibilityConnection,
) -> std::io::Result<()> {
    stream.set_read_timeout(None).ok();
    let mut writer = stream.try_clone()?;
    let reader = BufReader::new(stream);
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => {
                let _ = writeln!(writer, "{}", json!({"ok": false, "error": "invalid json"}));
                continue;
            }
        };
        let id = req.get("id").cloned().unwrap_or(json!(0));
        let method = req
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let params = req.get("params").cloned().unwrap_or(json!({}));
        let resp = if method == "authenticate" {
            json!({"id": id, "ok": true})
        } else if method == "broker_info" || method == "ping" {
            json!({"id": id, "ok": true, "result": {"ok": true, "platform": "linux", "helper": "cua-linux-helper"}})
        } else {
            let mut r = dispatch(&method, &params, &ac).await;
            if let Some(o) = r.as_object_mut() {
                o.insert("id".into(), id);
            }
            r
        };
        let _ = writeln!(writer, "{}", resp);
        let _ = writer.flush();
    }
    Ok(())
}
