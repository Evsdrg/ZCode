// KWin（KDE Wayland）窗口激活辅助。
//
// 背景：Wayland 下 portal 的输入注入只送到 seat 焦点窗口，不送到坐标命中的窗口。
// 坐标点击一个非焦点窗口会把事件打到别的应用上。桌面 Host 无此问题（mac/win 有
// 进程级注入路由），Linux 必须先把目标窗口提到焦点再注入。
//
// 实现：KWin 的 /Scripting D-Bus 接口可以加载一次性 JS 脚本，按窗口几何找到覆盖
// 指定坐标的顶层窗口并置 activation。只覆盖 KWin；其它合成器（GNOME/Mutter 等）
// 没有等价接口，本模块全部调用返回 Ok(None)（尽力而为，不影响注入主链路）。
//
// 脚本生命周期：loadScript 返回脚本 id，start 执行。执行完的脚本仍留在 KWin 里，
// 加载时用固定文件名会报 "already loaded"——因此每次生成唯一路径，并在执行后
// unloadScript 清理。KWin 脚本 API 见 org.kde.KWin /Scripting。

use std::time::Duration;

/// 一个 KWin 顶层窗口的真实屏幕几何（逻辑坐标）。
#[derive(Debug, Clone)]
pub struct WindowGeometry {
    /// 窗口类（如 "org.kde.kcalc"）。当前仅用于人工诊断，保留以便后续按类名匹配。
    #[allow(dead_code)]
    pub resource_class: String,
    /// 窗口标题。同上，保留。
    #[allow(dead_code)]
    pub caption: String,
    pub pid: i64,
    /// frameGeometry：含装饰（标题栏/边框）的外框。保留（窗口激活/装饰判定可用）。
    #[allow(dead_code)]
    pub frame: (f64, f64, f64, f64),
    /// clientGeometry：客户区（不含装饰）。AT-SPI 的 extents 与之同尺寸。
    pub client: (f64, f64, f64, f64),
}

/// 执行一段 KWin JS 脚本并返回它 `print()` 的输出行。
///
/// KWin 脚本的 print 只进 journal（kwin_wayland 的 stdout），因此这里用
/// `journalctl --user --since` 按时间窗捞取。失败返回空 Vec（调用方按
/// 「无 KWin」处理，fail-open 到不校正）。
async fn run_script_collect(script: &str, marker: &str) -> Vec<String> {
    let dir = std::env::temp_dir();
    // 唯一文件名：KWin 对同名脚本只加载一次（第二次 start 不会重跑）。
    let uniq = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let path = dir.join(format!("zcode-cua-script-{uniq}.js"));
    if std::fs::write(&path, script).is_err() {
        return Vec::new();
    }
    // 起始时间戳（留 2 秒余量，避免 journal 写入延迟）。
    let since = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().saturating_sub(3))
        .unwrap_or(0);
    let load = std::process::Command::new("gdbus")
        .args([
            "call", "--session", "--dest", "org.kde.KWin", "--object-path", "/Scripting",
            "--method", "org.kde.kwin.Scripting.loadScript", &path.to_string_lossy(),
        ])
        .output();
    let id = match load {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .split(|c: char| !c.is_ascii_digit())
            .find(|s| !s.is_empty())
            .and_then(|s| s.parse::<u32>().ok()),
        _ => {
            let _ = std::fs::remove_file(&path);
            return Vec::new();
        }
    };
    let started = std::process::Command::new("gdbus")
        .args([
            "call", "--session", "--dest", "org.kde.KWin", "--object-path", "/Scripting",
            "--method", "org.kde.kwin.Scripting.start",
        ])
        .output();
    let ok = matches!(started, Ok(ref o) if o.status.success());
    let mut lines = Vec::new();
    if ok {
        // 脚本执行是异步的：start 只代表 KWin 接受执行请求，print 输出要等脚本真正跑完。
        // 之前固定 sleep 200ms 在负载高时会漏读（表现为「无 KWin」静默降级）。
        // 改为最多轮询 2 秒，一旦出现 marker 就提前返回。
        tokio::time::sleep(Duration::from_millis(150)).await;
        // 用 timeout 硬性兜底：journalctl 在 systemd service 的 cgroup 里偶尔会长时间阻塞
        // （实测曾卡 110s），一旦超时就当作无 KWin，不能让 capture_app / element_at_point
        // 被拖死。--since 已限定时间窗，-n 再限条数，正常耗时为毫秒级。
        for attempt in 0..8 {
            let out = std::process::Command::new("timeout")
                .args([
                    "2",
                    "journalctl",
                    "--user",
                    "--since",
                    &format!("@{since}"),
                    "--no-pager",
                    "--output=cat",
                    "-n",
                    "500",
                ])
                .output();
            if let Ok(o) = out {
                for line in String::from_utf8_lossy(&o.stdout).lines() {
                    if let Some(pos) = line.find(marker) {
                        lines.push(line[pos + marker.len()..].trim().to_string());
                    }
                }
            }
            if !lines.is_empty() {
                break;
            }
            if attempt < 7 {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
    }
    if let Some(id) = id {
        let _ = std::process::Command::new("gdbus")
            .args([
                "call", "--session", "--dest", "org.kde.KWin", "--object-path", "/Scripting",
                "--method", "org.kde.kwin.Scripting.unloadScript", &id.to_string(),
            ])
            .output();
    }
    let _ = std::fs::remove_file(&path);
    lines
}

/// 读取所有 KWin 顶层普通窗口的真实几何。非 KWin 环境返回空 Vec。
pub async fn list_window_geometries() -> Vec<WindowGeometry> {
    // marker 带 nonce：同一脚本会被 capture_app / element_at_point 频繁调用，
    // 固定 marker 会读到先前调用的窗口列表（尤其窗口已移动/关闭时）。
    let nonce = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let marker = format!("ZCODEGEOM{nonce}|");
    let script = format!(
        r#"var ws = workspace.stackingOrder;
for (var i = 0; i < ws.length; i++) {{
    var w = ws[i];
    if (!w.normalWindow) continue;
    var f = w.frameGeometry;
    var c = w.clientGeometry;
    if (!f || !c) continue;
    print("{marker}" + (w.resourceClass || "") + "\u0001" + (w.caption || "") + "\u0001" +
          w.pid + "\u0001" +
          f.x + "," + f.y + "," + f.width + "," + f.height + "\u0001" +
          c.x + "," + c.y + "," + c.width + "," + c.height);
}}"#
    );
    let lines = run_script_collect(&script, &marker).await;
    let mut out = Vec::new();
    for line in lines {
        let parts: Vec<&str> = line.split('\u{1}').collect();
        if parts.len() != 5 {
            continue;
        }
        let parse4 = |s: &str| -> Option<(f64, f64, f64, f64)> {
            let v: Vec<f64> = s.split(',').filter_map(|x| x.trim().parse().ok()).collect();
            (v.len() == 4).then(|| (v[0], v[1], v[2], v[3]))
        };
        if let (Some(frame), Some(client)) = (parse4(parts[3]), parse4(parts[4])) {
            out.push(WindowGeometry {
                resource_class: parts[0].to_string(),
                caption: parts[1].to_string(),
                pid: parts[2].parse().unwrap_or(-1),
                frame,
                client,
            });
        }
    }
    out
}

/// 激活覆盖逻辑坐标 (x, y) 的 KWin 顶层窗口。返回是否成功激活（None=非 KWin/未找到）。
///
/// 尽力而为：任何失败都吞掉（只打日志），调用方继续走注入。
pub async fn activate_window_at(x: f64, y: f64) -> Option<bool> {
    // marker 带 nonce：journal 是全局共享的，固定 marker + since 时间窗会捞到上一次
    // 调用（甚至上一个 helper 进程）的同名输出，导致返回过期结果。
    let nonce = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let marker = format!("ZCODEACT{nonce}|");
    let script = format!(
        r#"var target = null;
// stackingOrder 从最顶层到底层；选覆盖该点的最上层窗口（与视觉一致：
// 坐标处看到的是什么窗口，就激活什么窗口）。
var ws = workspace.stackingOrder;
for (var i = 0; i < ws.length; i++) {{
    var w = ws[i];
    if (!w.normalWindow) continue;
    var g = w.frameGeometry;
    if (!g) continue;
    if (x >= g.x && x < g.x + g.width && y >= g.y && y < g.y + g.height) {{
        target = w;
        break;
    }}
}}
if (!target) {{
    print("{marker}NOTFOUND");
}} else if (target === workspace.activeWindow) {{
    print("{marker}WASACTIVE");
}} else {{
    workspace.activeWindow = target;
    print("{marker}ACTIVATED");
}}"#
    );
    // 把坐标注入脚本（数字字面量，避免拼接注入面）。
    let script = script
        .replace("x >=", &format!("({x}) >="))
        .replace("x <", &format!("({x}) <"))
        .replace("y >=", &format!("({y}) >="))
        .replace("y <", &format!("({y}) <"));
    let lines = run_script_collect(&script, &marker).await;
    for line in lines {
        let v = line.trim();
        if v == "ACTIVATED" || v == "WASACTIVE" {
            return Some(true);
        }
        if v == "NOTFOUND" {
            return Some(false);
        }
    }
    None
}

/// 按 pid 激活该进程的顶层窗口（`hold_key_to_app` 前确保键盘焦点在目标应用）。
///
/// Wayland 没有 pid 定向的键盘注入通道：portal 的 keyboard_keysym 只送 seat 焦点
/// 窗口。因此「向指定应用按住某个键」在 Linux 的等价实现 = 先把该 pid 的窗口提到
/// 前台，再注入。若非 KWin 或该 pid 无窗口，返回 None（调用方按不可用处理）。
pub async fn activate_window_by_pid(pid: i64) -> Option<bool> {
    // 关键：marker 必须带随机 nonce。journal 是全局共享的，固定 marker + since 时间窗
    // 会捞到上一次调用（甚至上一个 helper 进程）的同名输出，导致返回过期结果。
    let nonce = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let marker = format!("ZCODEPID{nonce}|");
    let script = format!(
        r#"var target = null;
var ws = workspace.stackingOrder;
for (var i = 0; i < ws.length; i++) {{
    var w = ws[i];
    if (!w.normalWindow) continue;
    if (w.pid !== {pid}) continue;
    target = w;
    break;
}}
if (!target) {{
    print("{marker}NOTFOUND");
}} else if (target === workspace.activeWindow) {{
    print("{marker}WASACTIVE");
}} else {{
    workspace.activeWindow = target;
    print("{marker}ACTIVATED");
}}"#
    );
    // 注意：run_script_collect 已把 marker 前缀剥掉（返回的是 marker 之后的内容）。
    let lines = run_script_collect(&script, &marker).await;
    for line in lines {
        let v = line.trim();
        if !v.is_empty() {
            return Some(v != "NOTFOUND");
        }
    }
    None
}
