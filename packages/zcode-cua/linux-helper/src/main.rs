// Linux Computer Use broker Helper（最小可运行版）
use atspi::connection::AccessibilityConnection;
use atspi::proxy::accessible::AccessibleProxy;
use atspi::proxy::component::ComponentProxy;
use atspi::proxy::action::ActionProxy;
use atspi::CoordType;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::Path;
use tokio::sync::Mutex;

const DEFAULT_DEPTH: usize = 10;
const MAX_ELEMENTS: usize = 2000;

#[derive(Clone)]
struct App { bname: String, path: String, name: String, pid: i64 }

type Conn = atspi::zbus::Connection;

async fn acc<'a>(conn: &'a Conn, name: &str, path: &str) -> Result<AccessibleProxy<'a>, String> {
    AccessibleProxy::builder(conn)
        .cache_properties(atspi::zbus::proxy::CacheProperties::No)
        .destination(name.to_string()).map_err(|e| e.to_string())?
        .path(path.to_string()).map_err(|e| e.to_string())?
        .build().await.map_err(|e| e.to_string())
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
    let root = ac.root_accessible_on_registry().await.map_err(|e| e.to_string())?;
    let kids = root.get_children().await.map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for k in kids {
        let bname = k.name().map(|n| n.to_string()).unwrap_or_default();
        let path = k.path().to_string();
        if bname.is_empty() { continue; }
        let pid = get_pid(conn, &bname).await.unwrap_or(-1);
        let ap = match acc(conn, &bname, &path).await { Ok(a)=>a, Err(_)=>continue };
        let name = ap.name().await.unwrap_or_default();
        if name.is_empty() { continue; }
        let cc = ap.child_count().await.unwrap_or(0);
        if cc <= 0 { continue; }
        out.push(App { bname, path, name, pid });
    }
    out.sort_by(|a,b| a.name.cmp(&b.name));
    Ok(out)
}

async fn get_actions(conn: &Conn, bname: &str, path: &str) -> Vec<String> {
    let b = match ActionProxy::builder(conn).cache_properties(atspi::zbus::proxy::CacheProperties::No).destination(bname.to_string()) { Ok(b)=>b, Err(_)=>return vec![] };
    let b = match b.path(path.to_string()) { Ok(b)=>b, Err(_)=>return vec![] };
    let apx = match b.build().await { Ok(a)=>a, Err(_)=>return vec![] };
    apx.get_actions().await.map(|v| v.into_iter().map(|a| a.name).collect()).unwrap_or_default()
}

async fn get_extents(conn: &Conn, bname: &str, path: &str) -> Option<(i32,i32,i32,i32)> {
    let b = ComponentProxy::builder(conn).cache_properties(atspi::zbus::proxy::CacheProperties::No).destination(bname.to_string()).ok()?;
    let b = b.path(path.to_string()).ok()?;
    let cp = b.build().await.ok()?;
    cp.get_extents(CoordType::Screen).await.ok()
}

struct WalkCtx { elements: Vec<Value>, lines: Vec<String> }

async fn walk(conn: &Conn, bname: &str, path: &str, depth: usize, owner_pid: i64, ctx: &mut WalkCtx) {
    if ctx.elements.len() >= MAX_ELEMENTS { return; }
    let ap = match acc(conn, bname, path).await { Ok(a)=>a, Err(_)=>return };
    let role = ap.get_role_name().await.unwrap_or_default();
    let name = ap.name().await.unwrap_or_default();
    let actions = get_actions(conn, bname, path).await;
    let ext = get_extents(conn, bname, path).await;
    let bounds = match ext { Some((x,y,w,h)) => json!([x,y,w,h]), None => json!([0,0,0,0]) };
    let lower = role.to_lowercase();
    let pressable = actions.iter().any(|a|{ let l=a.to_lowercase(); l.contains("press")||l=="click"||l.contains("activate")});
    let has_menu = actions.iter().any(|a| a.to_lowercase().contains("menu"));
    ctx.elements.push(json!({
        "role": role, "kind": lower.clone(),
        "title": if name.is_empty() { Value::Null } else { Value::String(name.clone()) },
        "value": Value::Null, "bounds": bounds, "enabled": true,
        "editable": lower.contains("text") || lower.contains("entry"),
        "actions": actions, "focused": false, "default_action": false,
        "pressable": pressable, "has_menu": has_menu, "native": "",
        "owner_pid": owner_pid, "depth": depth as i64,
    }));
    ctx.lines.push(format!("{}{}{}", "  ".repeat(depth), if lower.is_empty(){"element".to_string()}else{lower.clone()}, if name.is_empty(){String::new()}else{format!(" {}", name)}));
    if depth >= DEFAULT_DEPTH { return; }
    if let Ok(kids) = ap.get_children().await {
        for k in kids {
            let kn = k.name().map(|x| x.to_string()).unwrap_or_default();
            let kp = k.path().to_string();
            if kn.is_empty() { continue; }
            Box::pin(walk(conn, &kn, &kp, depth+1, owner_pid, ctx)).await;
        }
    }
}

fn find_app(apps: &[App], app_ref: &Value) -> Option<usize> {
    let pid = app_ref.get("pid").and_then(|v| v.as_i64());
    let name = app_ref.get("name").and_then(|v| v.as_str());
    let bundle = app_ref.get("bundle_id").and_then(|v| v.as_str());
    let mut hits: Vec<usize> = Vec::new();
    for (i,a) in apps.iter().enumerate() {
        if let Some(p)=pid { if a.pid==p { hits.push(i); continue; } }
        if let Some(n)=name { if a.name==n { hits.push(i); } }
        if let Some(b)=bundle { if a.name==b { hits.push(i); } }
    }
    hits.into_iter().next()
}

async fn capture_app(ac: &AccessibilityConnection, apps: &[App], app_ref: &Value) -> Result<Value, String> {
    let conn = ac.connection();
    let i = find_app(apps, app_ref).ok_or_else(|| "app not found".to_string())?;
    let a = &apps[i];
    let mut ctx = WalkCtx { elements: Vec::new(), lines: Vec::new() };
    walk(conn, &a.bname, &a.path, 0, a.pid, &mut ctx).await;
    // window：取 app 的第一个 frame/window 子节点的标题/bounds
    let mut wtitle = Value::Null; let mut wbounds = json!([0,0,0,0]);
    if let Ok(ap) = acc(conn, &a.bname, &a.path).await {
        if let Ok(kids) = ap.get_children().await {
            for k in kids {
                let kn = k.name().map(|x| x.to_string()).unwrap_or_default();
                let kp = k.path().to_string();
                if let Ok(kap) = acc(conn, &kn, &kp).await {
                    let r = kap.get_role_name().await.unwrap_or_default().to_lowercase();
                    if r.contains("frame") || r.contains("window") || r.contains("dialog") {
                        let t = kap.name().await.unwrap_or_default();
                        if !t.is_empty() { wtitle = Value::String(t); }
                        if let Some((x,y,w,h)) = get_extents(conn, &kn, &kp).await { wbounds = json!([x,y,w,h]); }
                        break;
                    }
                }
            }
        }
    }
    Ok(json!({
        "snapshot_mode": "full",
        "app": {"bundle_id": Value::Null, "pid": a.pid, "name": a.name, "aumid": Value::Null, "executable_path": Value::Null, "icon_png": Value::Null},
        "window": {"title": wtitle, "bounds": wbounds, "window_id": Value::Null},
        "elements": ctx.elements,
        "content": format!("App: {} (pid {})\n{}", a.name, a.pid, ctx.lines.join("\n")),
    }))
}

async fn dispatch(method: &str, params: &Value, ac: &AccessibilityConnection) -> Value {
    let conn = ac.connection();
    match method {
        "list_applications" => match list_apps(ac).await {
            Ok(apps) => {
                let arr: Vec<Value> = apps.iter().map(|a| json!({
                    "name": a.name, "bundle_id": Value::Null, "pid": a.pid, "active": false, "aumid": Value::Null
                })).collect();
                // SDK inventory 期望裸数组（或 {apps:[...]}），见 computer-use-client.mjs
                json!({"ok":true,"result":arr})
            }
            Err(e) => json!({"ok":false,"error":e}),
        },
        "capture_app" => {
            let app_ref = params.get("app_ref").cloned().unwrap_or(json!({}));
            match list_apps(ac).await {
                Ok(apps) => match capture_app(ac, &apps, &app_ref).await {
                    Ok(v)=>json!({"ok":true,"result":v}),
                    Err(e)=>json!({"ok":false,"error":e}),
                },
                Err(e)=>json!({"ok":false,"error":e}),
            }
        }
        "list_windows" => json!({"ok":true,"result":{"items":[]}}),
        other => json!({"ok":false,"error":format!("method not implemented yet: {other}")}),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut socket_path = String::new();
    let mut i = 1;
    while i < args.len() {
        if args[i] == "--socket" && i+1 < args.len() { socket_path = args[i+1].clone(); i+=2; } else { i+=1; }
    }
    if socket_path.is_empty() { eprintln!("usage: cua-linux-helper --socket <path>"); std::process::exit(2); }
    let _ = std::fs::remove_file(&socket_path);
    if let Some(parent) = Path::new(&socket_path).parent() { let _ = std::fs::create_dir_all(parent); }
    let listener = UnixListener::bind(&socket_path).expect("bind socket failed");
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600));
    eprintln!("cua-linux-helper listening on {socket_path}");

    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
    rt.block_on(async move {
        let ac = match AccessibilityConnection::new().await {
            Ok(a) => a,
            Err(e) => { eprintln!("cannot connect a11y bus: {e}"); std::process::exit(1); }
        };
        let listener = listener;
        let ac = std::sync::Arc::new(ac);
        for stream in listener.incoming() {
            let stream = match stream { Ok(s)=>s, Err(_)=>continue };
            let ac = ac.clone();
            let _ = handle_conn(stream, ac).await;
        }
    });
}

async fn handle_conn(stream: std::os::unix::net::UnixStream, ac: std::sync::Arc<AccessibilityConnection>) -> std::io::Result<()> {
    stream.set_read_timeout(None).ok();
    let mut writer = stream.try_clone()?;
    let reader = BufReader::new(stream);
    let mut lines = Vec::new();
    // 阻塞读：放到阻塞线程池
    for line in reader.lines() {
        lines.push(line);
        let line = match lines.pop() { Some(Ok(l))=>l, _=>break };
        if line.trim().is_empty() { continue; }
        let req: Value = match serde_json::from_str(&line) {
            Ok(v)=>v, Err(_)=>{ let _ = writeln!(writer, "{}", json!({"ok":false,"error":"invalid json"})); continue; }
        };
        let id = req.get("id").cloned().unwrap_or(json!(0));
        let method = req.get("method").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let params = req.get("params").cloned().unwrap_or(json!({}));
        let resp = if method == "authenticate" {
            json!({"id": id, "ok": true})
        } else if method == "broker_info" || method == "ping" {
            json!({"id": id, "ok": true, "result": {"ok": true, "platform": "linux", "helper": "cua-linux-helper"}})
        } else {
            let mut r = dispatch(&method, &params, &ac).await;
            if let Some(o)=r.as_object_mut() { o.insert("id".into(), id); }
            r
        };
        let _ = writeln!(writer, "{}", resp);
        let _ = writer.flush();
    }
    Ok(())
}
