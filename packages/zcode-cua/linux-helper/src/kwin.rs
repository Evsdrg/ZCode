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
    eprintln!("[kwin] loadScript ok: {}", String::from_utf8_lossy(&out.stdout).trim());
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
    eprintln!("[kwin] start: {}", match &start {
        Ok(o) if o.status.success() => "ok".to_string(),
        Ok(o) => format!("fail: {}", String::from_utf8_lossy(&o.stderr).trim()),
        Err(e) => format!("spawn fail: {e}"),
    });
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
