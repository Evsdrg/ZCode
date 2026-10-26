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

mod kwin;
mod portal;

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
use std::time::Duration;
use std::os::unix::net::UnixListener;
use std::path::Path;

// flock(2)：用于 helper 单实例保护（不引入 libc crate 的最小声明）。
const LOCK_EX: i32 = 2;
const LOCK_NB: i32 = 4;
extern "C" {
    fn flock(fd: i32, operation: i32) -> i32;
}

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

/// AT-SPI 单次调用超时。个别应用的 accessible 对象会永不响应（D-Bus 无回包），
/// 不设超时会让整次 capture 挂死（实测 rustdesk 的应用节点即如此）。
const ATSPI_CALL_TIMEOUT: Duration = Duration::from_millis(1500);

/// 跑一个 future，超时/失败都返回 None。
async fn timed<T>(fut: impl std::future::Future<Output = T>) -> Option<T> {
    tokio::time::timeout(ATSPI_CALL_TIMEOUT, fut).await.ok()
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

/// 取元素的可读文本（用于 element.value 投影）。
///
/// AT-SPI 的读取接口在 Text 上（EditableText 只有写接口，没有读），故统一走 TextProxy。
async fn get_text_value(conn: &Conn, bname: &str, path: &str) -> Option<String> {
    if let Ok(b) = TextProxy::builder(conn)
        .cache_properties(atspi::zbus::proxy::CacheProperties::No)
        .destination(bname.to_string())
        .and_then(|b| b.path(path.to_string()))
    {
        if let Ok(tp) = b.build().await {
            if let Ok(count) = tp.character_count().await {
                // 终端/日志类文本可能极长，截断避免单元素拖垮整棵树。
                if count > 0 {
                    let end = count.min(4096);
                    if let Ok(text) = tp.get_text(0, end).await {
                        if !text.is_empty() {
                            return Some(text);
                        }
                    }
                }
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
    offset: (f64, f64),
    ctx: &mut WalkCtx,
) {
    if ctx.elements.len() >= MAX_ELEMENTS {
        return;
    }
    let ap = match acc(conn, bname, path).await {
        Ok(a) => a,
        Err(_) => return,
    };
    let role = timed(ap.get_role_name()).await.and_then(|r| r.ok()).unwrap_or_default();
    let name = timed(ap.name()).await.and_then(|r| r.ok()).unwrap_or_default();
    let actions = timed(get_actions(conn, bname, path)).await.unwrap_or_default();
    let ext = timed(get_extents(conn, bname, path)).await.flatten();
    // 坐标校正：AT-SPI 的 Screen 坐标是否真是屏幕坐标因应用实现而异（KDE Wayland 实测：
    // 腾讯会议/VirtualBox 给真实屏幕坐标，rustdesk/phone-cam-manager/kdialog/consoLe 给
    // (0,0) 原点局部坐标）。统一用 `atspi + (kwin_client_origin - atspi_window_origin)`
    // 换算：两种情况都成立（前者偏移为 0，后者偏移为窗口真实位置）。
    // AT-SPI 用 INT_MIN 表示「位置未知」。这类元素不可按坐标点击，bounds 置 null，
    // 让 agent 明确知道无法用坐标定位（仍可用元素级动作）。
    // AT-SPI 用 INT_MIN 表示「位置未知」，另有元素报 0 尺寸/极小负值（不可见装饰）。
    // 这些元素无法按坐标点击，bounds 置 null，让 agent 明确知道要用元素级动作。
    const ATSPI_COORD_UNKNOWN: i32 = i32::MIN;
    let bounds = match ext {
        Some((x, y, w, h))
            if x > ATSPI_COORD_UNKNOWN
                && y > ATSPI_COORD_UNKNOWN
                && w > 0
                && h > 0
                && (x as f64 + offset.0) >= -8.0
                && (y as f64 + offset.1) >= -8.0 =>
        {
            json!([
                x as f64 + offset.0,
                y as f64 + offset.1,
                w as f64,
                h as f64
            ])
        }
        _ => Value::Null,
    };
    let value = timed(get_text_value(conn, bname, path)).await.flatten();
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
    let kids_opt = timed(ap.get_children()).await;
    if let Some(Ok(kids)) = kids_opt {
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
            Box::pin(walk(
                conn,
                &use_bname,
                &kp,
                depth + 1,
                owner_pid,
                win_bounds,
                offset,
                ctx,
            ))
            .await;
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
    // 计算坐标偏移：用 KWin 的真实 clientGeometry 校正 AT-SPI 的窗口原点。
    // 按 pid 匹配（resourceClass 与 AT-SPI app 名不一定同名），拿不到则不校正（offset=0）。
    let mut offset = (0.0f64, 0.0f64);
    let mut geom_source = "none";
    let all_geoms = kwin::list_window_geometries().await;
    if let Some(g) = all_geoms
        .into_iter()
        .find(|g| g.pid == a.pid)
    {
        // AT-SPI 报的窗口 extents（若为 (0,0) 则视为局部坐标）
        let ax = wbounds[0].as_f64().unwrap_or(0.0);
        let ay = wbounds[1].as_f64().unwrap_or(0.0);
        // 尺寸一致性校验：AT-SPI 窗口尺寸应等于 client 尺寸（容差 2px）
        let aw = wbounds[2].as_f64().unwrap_or(0.0);
        let ah = wbounds[3].as_f64().unwrap_or(0.0);
        let size_ok = (aw - g.client.2).abs() <= 2.0 && (ah - g.client.3).abs() <= 2.0;
        if size_ok {
            offset = (g.client.0 - ax, g.client.1 - ay);
            geom_source = "kwin-client-geometry";
        }
    }
    let mut ctx = WalkCtx {
        elements: Vec::new(),
        lines: Vec::new(),
    };
    walk(conn, &a.bname, &a.path, 0, a.pid, wb, offset, &mut ctx).await;
    Ok(json!({
        "snapshot_mode": "full",
        // 坐标空间：bounds 已按 KWin clientGeometry 校正为【屏幕逻辑坐标】（可直接用于
        // click 的 point）。若 geom_source 为 "none"（无 KWin / 尺寸不匹配 / 非 KDE），
        // bounds 保持 AT-SPI 原值，可能为窗口局部坐标——此时应改用元素级动作
        // （element_perform_action / element_set_value），它们不依赖坐标。
        "coordinate_space": if geom_source == "none" { "atspi-raw" } else { "screen" },
        "coordinate_source": geom_source,
        // elements[].bounds 是【逻辑像素】的屏幕坐标，可直接用于 click/scroll 的 point。
        // 与 screenshot 的关系：截图 raster 坐标 ÷ screenshot.scale = 逻辑坐标。
        "bounds_note": "bounds are logical-pixel screen coordinates usable directly as click points; for coordinates measured on a screenshot, divide by screenshot scale (e.g. 1.25) first",
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

/// 元素滚动：AT-SPI 的滚动实现路径。
///
/// Qt/KDE 不实现 `Component.ScrollTo`（实测报 No such object path），因此走
/// **滚动条动作**：找到目标元素所在滚动容器的 `scroll bar` 兄弟节点，调用其
/// `Increase` / `Decrease` 动作。direction=up/down 用竖直滚动条、left/right 用水平。
///
/// amount（0..100）映射为动作重复次数（1..10 次），因为滚动条动作是固定步长的
/// 「翻一页」，没有像素级接口。已在 KWrite（200 行文本）验证：6 次 Increase
/// 使文本区产生 1911 像素变化。
async fn element_scroll(ac: &AccessibilityConnection, params: &Value) -> Value {
    let conn = ac.connection();
    let token = match params.get("native").and_then(|v| v.as_str()) {
        Some(t) => t,
        None => return fail("action_unavailable", "element_scroll: missing native token", false),
    };
    let dir = params
        .get("direction")
        .and_then(|v| v.as_str())
        .unwrap_or("down")
        .to_lowercase();
    let amount = params.get("amount").and_then(|v| v.as_f64()).unwrap_or(10.0);
    let (bname, path) = match parse_native(token) {
        Some(x) => x,
        None => return fail("action_unavailable", "element_scroll: invalid native token", false),
    };

    let vertical = dir != "left" && dir != "right";
    let increase = dir == "down" || dir == "right";
    let action_name = if increase { "Increase" } else { "Decrease" };
    let repeats = ((amount / 10.0).round() as i64).clamp(1, 10);

    // 逐层向上寻找 scroll bar 兄弟节点：目标元素自己可能就是 scroll bar；
    // 否则看它的父节点下有没有朝向匹配的 scroll bar 子节点。
    let ap = match AccessibleProxy::builder(conn)
        .cache_properties(atspi::zbus::proxy::CacheProperties::No)
        .destination(bname.clone())
        .and_then(|b| b.path(path.clone()))
    {
        Ok(b) => b,
        Err(e) => return fail("action_unavailable", &format!("element_scroll: accessible proxy: {e}"), false),
    };
    let mut cur = match ap.build().await {
        Ok(p) => p,
        Err(e) => return fail("action_unavailable", &format!("element_scroll: build: {e}"), false),
    };

    // 最多向上找 4 层，覆盖 Qt 常见的 filler/layered pane 嵌套。
    for _ in 0..4 {
        let kids = match timed(cur.get_children()).await {
            Some(Ok(k)) => k,
            _ => Vec::new(),
        };
        for k in kids {
            let kp = k.path().to_string();
            let kb = k.name().map(|x| x.to_string()).unwrap_or_default();
            let kb = if kb.is_empty() { bname.clone() } else { kb };
            let kpx = match ActionProxy::builder(conn)
                .cache_properties(atspi::zbus::proxy::CacheProperties::No)
                .destination(kb.clone())
                .and_then(|b| b.path(kp.clone()))
            {
                Ok(b) => b,
                Err(_) => continue,
            };
            let kpx = match kpx.build().await {
                Ok(p) => p,
                Err(_) => continue,
            };
            let role = match timed(cur.get_role_name()).await {
                Some(Ok(_)) => String::new(),
                _ => String::new(),
            };
            let _ = role;
            // 检查这个兄弟是不是 scroll bar（用其 accessible role）
            let accp = match AccessibleProxy::builder(conn)
                .cache_properties(atspi::zbus::proxy::CacheProperties::No)
                .destination(kb.clone())
                .and_then(|b| b.path(kp.clone()))
            {
                Ok(b) => b,
                Err(_) => continue,
            };
            let accp = match accp.build().await {
                Ok(p) => p,
                Err(_) => continue,
            };
            let r = match timed(accp.get_role_name()).await {
                Some(Ok(r)) => r,
                _ => continue,
            };
            if r.to_lowercase() != "scroll bar" {
                continue;
            }
            // 用 extents 判断朝向：高 > 宽 视为竖直滚动条。
            let ext = match get_extents(conn, &kb, &kp).await {
                Some(e) => e,
                None => continue,
            };
            let is_vertical_bar = ext.3 > ext.2;
            if is_vertical_bar != vertical {
                continue;
            }
            let acts = match timed(kpx.get_actions()).await {
                Some(Ok(a)) => a,
                _ => continue,
            };
            let mut idx: Option<i32> = None;
            for (i, a) in acts.iter().enumerate() {
                if a.name.eq_ignore_ascii_case(action_name) {
                    idx = Some(i as i32);
                    break;
                }
            }
            let idx = match idx {
                Some(i) => i,
                None => continue,
            };
            for _ in 0..repeats {
                if let Err(e) = kpx.do_action(idx).await {
                    return fail(
                        "action_unavailable",
                        &format!("element_scroll: do_action {action_name}: {e}"),
                        false,
                    );
                }
                tokio::time::sleep(std::time::Duration::from_millis(60)).await;
            }
            return json!({"ok": true, "result": {
                "action_sent": true,
                "dispatch_status": "accepted",
                "repeats": repeats,
                "action": action_name,
            }});
        }
        // 向上走一层
        let parent = match timed(cur.parent()).await {
            Some(Ok(p)) => p,
            _ => break,
        };
        let pp = parent.path().to_string();
        let pn = parent.name().map(|x| x.to_string()).unwrap_or_default();
        let pb = if pn.is_empty() { bname.clone() } else { pn };
        let np = match AccessibleProxy::builder(conn)
            .cache_properties(atspi::zbus::proxy::CacheProperties::No)
            .destination(pb)
            .and_then(|b| b.path(pp))
        {
            Ok(b) => b,
            Err(_) => break,
        };
        cur = match np.build().await {
            Ok(p) => p,
            Err(_) => break,
        };
    }
    fail(
        "action_unavailable",
        &format!("element_scroll: no scroll bar ({action_name}) found for this element"),
        false,
    )
}

/// 命中测试：用 AT-SPI Component.GetAccessibleAtPoint 做原生命中。
///
/// 输入是【屏幕逻辑坐标】（agent 从截图/元素 bounds 得来），而 AT-SPI 的
/// GetAccessibleAtPoint 在 KDE Wayland 下按各应用自己的坐标空间解释：有的应用
/// 要屏幕坐标，有的要窗口局部坐标。因此逐窗口尝试两个坐标：
///   1) 原值（屏幕坐标应用直接命中）
///   2) 平移到该窗口局部坐标（屏幕坐标 − KWin client 原点，命中局部坐标应用）
/// 命中即返回 native token + 真实 owner_pid。
async fn element_at_point(ac: &AccessibilityConnection, params: &Value) -> Value {
    let conn = ac.connection();
    let x = params.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let y = params.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let apps = match list_apps(ac).await {
        Ok(a) => a,
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    // KWin 真实几何：按 pid 索引，用于把屏幕坐标平移成窗口局部坐标。
    let geoms = kwin::list_window_geometries().await;
    // 收集所有窗口（面积升序：小窗口优先，避免全屏/桌面窗口抢命中）。
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
        let cp = match cp {
            Some(c) => c,
            None => continue,
        };
        // 该窗口的 AT-SPI 原点与 KWin client 原点，求局部坐标下的查询点。
        let mut candidates: Vec<(i32, i32)> = vec![(x as i32, y as i32)];
        if let (Some((ax, ay, aw, ah)), Some(g)) =
            (get_extents(conn, &bn, &kp).await, geoms.iter().find(|g| g.pid == pid))
        {
            // 尺寸匹配才认为这个 KWin 窗口就是该 AT-SPI 窗口（同 pid 多窗口时避误配）。
            if (aw as f64 - g.client.2).abs() <= 2.0 && (ah as f64 - g.client.3).abs() <= 2.0 {
                // 局部坐标 = 屏幕坐标 − (KWin client 原点 − AT-SPI 窗口原点)
                let ox = g.client.0 - ax as f64;
                let oy = g.client.1 - ay as f64;
                let lx = (x - ox).round() as i32;
                let ly = (y - oy).round() as i32;
                if (lx, ly) != (x as i32, y as i32) {
                    candidates.push((lx, ly));
                }
            }
        }
        for (cx, cy) in candidates {
            if let Ok(obj) = cp.get_accessible_at_point(cx, cy, CoordType::Screen).await {
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

/// 从 params.point 取逻辑坐标（x,y）。
/// 从任意含 x/y 的对象取点（drag 的 start/end 用）。
fn point_of_value(p: &Value) -> Option<(f64, f64)> {
    let x = p.get("x").and_then(|v| v.as_f64())?;
    let y = p.get("y").and_then(|v| v.as_f64())?;
    Some((x, y))
}

/// 解析 drag 的修饰键列表。broker 传的是 mac 命名（cmd/opt/ctrl/shift），
/// Linux 映射：cmd→Super_L、opt→Alt_L、ctrl→Control_L、shift→Shift_L。
fn parse_modifier_list(v: Option<&Value>) -> Vec<i32> {
    let mut out = Vec::new();
    let Some(val) = v else { return out };
    let text = match val {
        Value::String(s) => s.clone(),
        Value::Array(arr) => arr
            .iter()
            .filter_map(|x| x.as_str())
            .collect::<Vec<_>>()
            .join("+"),
        _ => return out,
    };
    for part in text.split('+').map(|s| s.trim()).filter(|s| !s.is_empty()) {
        let ks = match part.to_lowercase().as_str() {
            "cmd" | "command" | "super" | "meta" | "win" => 0xFFEB, // Super_L
            "opt" | "option" | "alt" => 0xFFE9,                     // Alt_L
            "ctrl" | "control" => 0xFFE3,                           // Control_L
            "shift" => 0xFFE1,                                      // Shift_L
            _ => continue,
        };
        if !out.contains(&ks) {
            out.push(ks);
        }
    }
    out
}

fn point_of(params: &Value) -> Option<(f64, f64)> {
    let p = params.get("point")?;
    let x = p.get("x").and_then(|v| v.as_f64())?;
    let y = p.get("y").and_then(|v| v.as_f64())?;
    Some((x, y))
}

fn button_code(params: &Value) -> i32 {
    match params
        .get("button")
        .and_then(|v| v.as_str())
        .unwrap_or("left")
    {
        "right" => portal::BTN_RIGHT,
        "middle" => portal::BTN_MIDDLE,
        _ => portal::BTN_LEFT,
    }
}

/// 解析 key 工具的组合键字符串（如 "ctrl+a"、"shift+tab"、"return"）为 keysym 事件序列。
fn parse_chord(text: &str) -> Result<Vec<(i32, bool)>, String> {
    let parts: Vec<&str> = text.split('+').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    if parts.is_empty() {
        return Err("empty key text".into());
    }
    let (mods, key) = parts.split_at(parts.len() - 1);
    let mut ev = Vec::new();
    let mut mod_ks = Vec::new();
    for m in mods {
        let ks = portal::modifier_keysym(m)
            .ok_or_else(|| format!("unknown modifier {m:?}"))?;
        mod_ks.push(ks);
        ev.push((ks, true));
    }
    let key_ks = portal::named_key_keysym(key[0])
        .ok_or_else(|| format!("unknown key {:?}", key[0]))?;
    ev.push((key_ks, true));
    ev.push((key_ks, false));
    for ks in mod_ks.into_iter().rev() {
        ev.push((ks, false));
    }
    Ok(ev)
}

/// 标准 base64 编码（避免为一个函数引依赖）。
fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
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
        // 只移动指针（绝对坐标，逻辑像素）。供 agent 精确定位/测试使用。
        "move_pointer" => {
            let (x, y) = match point_of(params) {
                Some(p) => p,
                None => return fail("action_unavailable", "move_pointer: missing point", false),
            };
            match portal::move_pointer(x, y).await {
                Ok(()) => json!({"ok": true, "result": {"moved": true}}),
                Err(e) => fail("action_unavailable", &format!("move_pointer: {e}"), false),
            }
        }
        "element_at_point" => element_at_point(ac, params).await,
        "element_perform_action" => element_perform_action(ac, params).await,
        "element_set_value" => element_set_value(ac, params).await,
        "element_select_text" => element_select_text(ac, params).await,
        // 系统级授权状态：accessibility=AT-SPI（能读树即 granted）；screen_recording/输入注入
        // =xdg-desktop-portal RemoteDesktop（已授权会话存在即 granted）。
        "permission_status" => {
            let granted = portal::has_session().await;
            json!({"ok": true, "result": {
                "accessibility": "granted",
                "screen_recording": if granted { "granted" } else { "denied" },
                "grant_owner": "xdg-desktop-portal",
                "needs_grant": !granted
            }})
        }
        // 主动请求授权（UI 的「请求授权」按钮 → 触发一次 portal 弹窗，restore_token 持久化）。
        "request_access" => match portal::ensure_session().await {
            Ok(()) => json!({"ok": true, "result": {"granted": true}}),
            Err(e) => fail("action_unavailable", &format!("request_access: {e}"), false),
        },
        "reset_access" => {
            portal::reset_session().await;
            json!({"ok": true, "result": {"granted": false}})
        }
        // 坐标点击：point(逻辑坐标) → absolute motion + button press/release。
        "click" => {
            let (x, y) = match point_of(params) {
                Some(p) => p,
                None => return fail("action_unavailable", "click: missing point", false),
            };
            let button = button_code(params);
            let clicks = params.get("clicks").and_then(|v| v.as_u64()).unwrap_or(1) as u32;
            // Wayland 约束：portal 注入只送达 seat 焦点窗口，不是坐标命中的窗口。
            // 坐标点击前先尽量激活覆盖该坐标的窗口（KWin 脚本接口，尽力而为；
            // 非 KWin 或失败则跳过——与直接注入同一窗口时行为不变）。
            let _ = kwin::activate_window_at(x, y).await;
            match portal::click(x, y, button, clicks).await {
                Ok(()) => json!({"ok": true, "result": {"action_sent": true, "dispatch_status": "accepted"}}),
                Err(e) => fail("action_unavailable", &format!("click: {e}"), false),
            }
        }
        // 滚动：point + direction + amount(0..100) → pointer axis。
        "scroll" => {
            // 滚轮语义用离散步进（NotifyPointerAxisDiscrete）：整数步进与真实滚轮一致，
            // 避免 continuous axis 小数 delta 在不同合成器上被量化丢失。
            let amount = params.get("amount").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let dir = params.get("direction").and_then(|v| v.as_str()).unwrap_or("down");
            let (x, y) = match point_of(params) {
                Some(p) => p,
                None => return fail("action_unavailable", "scroll: missing point", false),
            };
            // KWin fakeinput 的 axis 走的是 deltaV120=0 分支（pointer.cpp: sendAxis），
            // 即被当作「finger/continuous scroll」的像素级 delta，而不是滚轮格数。
            // 实测 steps=3 只等于 3 像素（肉眼不可见），必须按像素量级放大：
            // amount(0..100) → 每单位 40px（amount=10 ≈ 400px，约一屏的 1/4）。
            let mag = (amount.clamp(1.0, 100.0) * 40.0).round() as i32;
            let (horiz, steps) = match dir {
                "up" => (false, -mag),
                "down" => (false, mag),
                "left" => (true, -mag),
                "right" => (true, mag),
                _ => (false, mag),
            };
            // KWin 的 PointerInterface::sendAxis 直接读 d->focusedSurface，没有就静默丢弃；
            // 与 notifyPointerMotion/notifyPointerButton 不同，axis 自己不会更新 pointer focus。
            // 因此滚动前先把指针移到目标点（等价于真实用户把鼠标停在内容上再滚轮）。
            let _ = portal::move_pointer(x, y).await;
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
            match portal::scroll_discrete(horiz, steps).await {
                Ok(()) => json!({"ok": true, "result": {"action_sent": true, "dispatch_status": "accepted"}}),
                Err(e) => fail("action_unavailable", &format!("scroll: {e}"), false),
            }
        }
        // 键盘组合键：text 如 "ctrl+a"/"return"。
        "key" => {
            let text = params.get("text").and_then(|v| v.as_str()).unwrap_or("");
            match parse_chord(text) {
                Ok(events) => match portal::key_events(events).await {
                    Ok(()) => json!({"ok": true, "result": {"action_sent": true, "dispatch_status": "accepted"}}),
                    Err(e) => fail("action_unavailable", &format!("key: {e}"), false),
                },
                Err(e) => fail("action_unavailable", &format!("key: {e}"), false),
            }
        }
        // 文本输入（app 级/全局）：text → keysym 序列。非 ASCII 暂不支持。
        "type" | "paste" => {
            let text = params.get("text").and_then(|v| v.as_str()).unwrap_or("");
            let events = portal::text_to_key_events(text);
            if events.is_empty() && !text.is_empty() {
                return fail("action_unavailable", &format!("{method}: text not representable as keysyms (non-ASCII)"), false);
            }
            match portal::key_events(events).await {
                Ok(()) => json!({"ok": true, "result": {"action_sent": true, "dispatch_status": "accepted"}}),
                Err(e) => fail("action_unavailable", &format!("{method}: {e}"), false),
            }
        }
        // 抓屏：portal ScreenCast → PipeWire → gstreamer 转 PNG。
        "screenshot" => match portal::capture_png().await {
            Ok(png) => {
                // 截图 raster 尺寸受桌面缩放影响（本机 DPR=1.25：逻辑 3072x1728 → raster
                // 3840x2160）。所有注入/AT-SPI/KWin 坐标都是逻辑像素，因此 agent 从截图上
                // 量出的坐标必须除以 scale 才能用。把 scale 与逻辑尺寸一并返回，避免猜测。
                let raster = png_raster_size(&png);
                let logical = portal::screen_logical_size().await.ok();
                let scale = match (raster, logical) {
                    (Some((rw, _)), Some((lw, _))) if lw > 0.0 => Some(rw as f64 / lw),
                    _ => None,
                };
                let b64 = base64_encode(&png);
                json!({"ok": true, "result": {
                    "content": [{
                        "type": "image",
                        "data": b64,
                        "mimeType": "image/png"
                    }],
                    "structuredContent": {
                        "raster_size": raster.map(|(w, h)| json!([w, h])),
                        "logical_size": logical.map(|(w, h)| json!([w, h])),
                        "scale": scale,
                        "coordinate_note": "screenshot pixels are physical (raster) pixels; divide by `scale` to get logical coordinates used by click/AT-SPI bounds"
                    }
                }})
            }
            Err(e) => fail("action_unavailable", &format!("screenshot: {e}"), false),
        },
        // 元素滚动：AT-SPI 滚动条动作（Qt 不实现 Component.ScrollTo）。
        "element_scroll" => element_scroll(ac, params).await,
        // 拖拽：portal RemoteDesktop（按下 → 分步移动 → 抬起，可带修饰键）。
        "drag" => {
            let start = params.get("start").and_then(point_of_value);
            let end = params.get("end").and_then(point_of_value);
            let (start, end) = match (start, end) {
                (Some(a), Some(b)) => (a, b),
                _ => return fail("action_unavailable", "drag: missing start/end point", false),
            };
            let modifiers = parse_modifier_list(params.get("modifiers"));
            match portal::drag(start, end, modifiers).await {
                Ok(()) => json!({"ok": true, "result": {"action_sent": true, "dispatch_status": "accepted"}}),
                Err(e) => fail("action_unavailable", &format!("drag: {e}"), false),
            }
        }
        // 按住键：portal keyboard_keysym 按下 → 等待 → 抬起；可被 cancel_input_holds 打断。
        //
        // hold_key_to_app：Wayland 无 pid 定向键盘通道（portal 只送 seat 焦点窗口），
        // 因此等价实现是先用 KWin 把目标 pid 的窗口提到前台再注入。若目标无法前置
        // （非 KWin / 窗口不存在），fail-closed 返回 action_unavailable，绝不把按键
        // 发给错误的窗口。
        "hold_key" | "hold_key_to_app" => {
            if method == "hold_key_to_app" {
                let pid = params
                    .get("app_ref")
                    .and_then(|v| v.get("pid"))
                    .and_then(|v| v.as_i64());
                let Some(pid) = pid else {
                    return fail(
                        "action_unavailable",
                        "hold_key_to_app: app_ref.pid required on Linux (keyboard targets the focused window)",
                        false,
                    );
                };
                match kwin::activate_window_by_pid(pid).await {
                    Some(true) => {}
                    Some(false) => {
                        return fail(
                            "action_unavailable",
                            &format!("hold_key_to_app: no window for pid {pid}"),
                            false,
                        )
                    }
                    None => {
                        return fail(
                            "action_unavailable",
                            "hold_key_to_app: cannot focus target window (KWin scripting unavailable)",
                            false,
                        )
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(120)).await;
            }
            let text = params.get("text").and_then(|v| v.as_str()).unwrap_or("");
            let duration = params.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0);
            if duration <= 0.0 {
                return json!({"ok": true, "result": {"action_sent": false, "reason": "zero_duration"}});
            }
            // hold_key 的 text 可能是修饰键名（shift/ctrl/alt/super）、命名键（return/tab/…）
            // 或单个字符。按此顺序解析。
            let keysym = match portal::modifier_keysym(text)
                .or_else(|| portal::named_key_keysym(text))
                .or_else(|| {
                    let mut it = text.chars();
                    let c = it.next()?;
                    if it.next().is_none() {
                        portal::char_to_keysym(c)
                    } else {
                        None
                    }
                })
            {
                Some(k) => k,
                None => return fail("action_unavailable", &format!("hold_key: unsupported key {text:?}"), false),
            };
            let ms = (duration * 1000.0).clamp(0.0, 30_000.0) as u64;
            match portal::hold_key(keysym, ms).await {
                Ok(()) => json!({"ok": true, "result": {"action_sent": true, "dispatch_status": "accepted", "held_seconds": ms as f64 / 1000.0}}),
                Err(e) if e == "cancelled" => json!({"ok": false, "error": {
                    "message": "hold_key cancelled", "code": "cancelled",
                    "details": {"action_sent": true, "reason": "cancelled"}
                }}),
                Err(e) => fail("action_unavailable", &format!("hold_key: {e}"), false),
            }
        }
        // 控制通道：取消进行中的 hold（broker 在另一条连接上调用）。
        "cancel_input_holds" => {
            let had = portal::cancel_hold();
            json!({"ok": true, "result": {"cancelled": had}})
        }
        other => json!({"ok": false, "error": format!("method not implemented: {other}")}),
    }
}

/// 从 PNG 头读取 raster 宽度/高度（IHDR 固定偏移 16..24，大端）。
fn png_raster_size(png: &[u8]) -> Option<(u32, u32)> {
    if png.len() < 24 || &png[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes([png[16], png[17], png[18], png[19]]);
    let h = u32::from_be_bytes([png[20], png[21], png[22], png[23]]);
    Some((w, h))
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
    // 单实例保护：同一 socket 路径只允许一个 helper。
    // 用 <socket>.lock 上的 flock 排它锁——拿不到说明已有实例在服务，直接退出（退出码 0，
    // 让调用方按「已有活 helper」处理，而不是误以为是启动失败）。
    // 这修掉了「父进程 probe 超时 → 删 socket → 再 spawn」导致的 helper 泄漏。
    let lock_path = format!("{socket_path}.lock");
    let lock_file = match std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open(&lock_path)
    {
        Ok(f) => f,
        Err(e) => {
            eprintln!("cannot open lock file {lock_path}: {e}");
            std::process::exit(1);
        }
    };
    {
        use std::os::unix::io::AsRawFd;
        let rc = unsafe { flock(lock_file.as_raw_fd(), LOCK_EX | LOCK_NB) };
        if rc != 0 {
            eprintln!("another cua-linux-helper already owns {socket_path}; exiting");
            std::process::exit(0);
        }
    }
    let _keep_lock = lock_file; // 持有到进程结束
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
