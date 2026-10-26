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
        .map(|d| d.as_secs().saturating_sub(2))
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
    tokio::time::sleep(Duration::from_millis(200)).await;
    let mut lines = Vec::new();
    if ok {
        // 用 timeout 硬性兜底：journalctl 在 systemd service 的 cgroup 里偶尔会长时间阻塞
        // （实测曾卡 110s），一旦超时就当作无 KWin，不能让 capture_app / element_at_point
        // 被拖死。--since 已限定时间窗，-n 再限条数，正常耗时为毫秒级。
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
    let script = r#"var ws = workspace.stackingOrder;
for (var i = 0; i < ws.length; i++) {
    var w = ws[i];
    if (!w.normalWindow) continue;
    var f = w.frameGeometry;
    var c = w.clientGeometry;
    if (!f || !c) continue;
    print("ZCODEGEOM|" + (w.resourceClass || "") + "\u0001" + (w.caption || "") + "\u0001" +
          w.pid + "\u0001" +
          f.x + "," + f.y + "," + f.width + "," + f.height + "\u0001" +
          c.x + "," + c.y + "," + c.width + "," + c.height);
}"#;
    let lines = run_script_collect(script, "ZCODEGEOM|").await;
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
    print("ZCODE-NOTFOUND");
}} else if (target === workspace.activeWindow) {{
    print("ZCODE-WASACTIVE");
}} else {{
    workspace.activeWindow = target;
    print("ZCODE-ACTIVATED");
}}"#
    );
    // 把坐标注入脚本（数字字面量，避免拼接注入面）。
    let script = script.replace("x >=", &format!("({x}) >="))
        .replace("x <", &format!("({x}) <"))
        .replace("y >=", &format!("({y}) >="))
        .replace("y <", &format!("({y}) <"));
    let dir = std::env::temp_dir();
    let path = dir.join(format!("zcode-cua-activate-{}.js", std::process::id()));
    if let Err(e) = std::fs::write(&path, &script) {
        eprintln!("[kwin] write script failed: {e}");
        return None;
    }
    let cleanup = || {
        let _ = std::fs::remove_file(&path);
    };
    // KWin D-Bus 不在 helper 的业务 runtime 里跑（zbus 连接要自己的 reactor），
    // 这里用同步 gdbus 子进程最省事，失败即返回。
    let out = std::process::Command::new("gdbus")
        .args([
            "call",
            "--session",
            "--dest",
            "org.kde.KWin",
            "--object-path",
            "/Scripting",
            "--method",
            "org.kde.kwin.Scripting.loadScript",
            &path.to_string_lossy(),
        ])
        .output();
    let out = match out {
        Ok(o) if o.status.success() => o,
        Ok(o) => {
            eprintln!(
                "[kwin] loadScript failed: {}",
                String::from_utf8_lossy(&o.stderr).trim()
            );
            cleanup();
            return None; // 无 KWin 或 D-Bus 不可用
        }
        Err(e) => {
            eprintln!("[kwin] spawn gdbus failed: {e}");
            cleanup();
            return None;
        }
    };
    // 返回形如 (uint32 42,) 或 (42,)——直接提取第一个连续数字串。
    let stdout = String::from_utf8_lossy(&out.stdout);
    let id = stdout
        .split(|c: char| !c.is_ascii_digit())
        .find(|s| !s.is_empty())
        .and_then(|s| s.parse::<u32>().ok());
    let id = match id {
        Some(i) => i,
        None => {
            cleanup();
            return None;
        }
    };
    let start = std::process::Command::new("gdbus")
        .args([
            "call", "--session", "--dest", "org.kde.KWin", "--object-path", "/Scripting",
            "--method", "org.kde.kwin.Scripting.start",
        ])
        .output();
    let _ = start;
    // 给 KWin 一点时间应用焦点切换，然后卸载脚本（一次性）。
    tokio::time::sleep(Duration::from_millis(120)).await;
    let _ = std::process::Command::new("gdbus")
        .args([
            "call", "--session", "--dest", "org.kde.KWin", "--object-path", "/Scripting",
            "--method", "org.kde.kwin.Scripting.unloadScript",
            &id.to_string(),
        ])
        .output();
    cleanup();
    Some(true)
}
