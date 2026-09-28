// packages/ui 测试的全局装配。
//
// 只做两件必须在此处完成、不能放进单个测试文件的事：
// 1. 声明 React 的 act 环境（React 19 + @testing-library/react 要求）；
// 2. 兜底注册自定义元素，让 <webview> 之类的标签在 happy-dom 里可被创建
//    （CodingPlanEmbeddedWebviewDialog 依赖 customElements.get("webview")）。
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
