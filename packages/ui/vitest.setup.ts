// packages/ui 测试的全局装配。
//
// 只做两件必须在此处完成、不能放进单个测试文件的事：
// 1. 声明 React 的 act 环境（React 19 + @testing-library/react 要求）；
// 2. 让 customElements.get("webview") 在测试环境返回已注册，模拟 Electron 宿主
//    （BrowserViewportSurface 与 CodingPlanEmbeddedWebviewDialog 依赖这个判据）。
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Electron 的 `<webview>` 是内置特殊标签，并不通过 customElements 注册（规范要求自定义
// 元素名必须含连字符，define("webview") 会直接抛 SyntaxError），因此 happy-dom 里
// customElements.get("webview") 恒为 undefined，上述两个组件会判定 guest 不可用而不挂载。
// 这里只改写 get("webview") 一个查询点，其余自定义元素行为保持原样。
if (typeof customElements !== "undefined" && typeof customElements.get === "function") {
  const originalGet = customElements.get.bind(customElements);
  customElements.get = ((name: string) =>
    name === "webview"
      ? class WebviewStub extends HTMLElement {}
      : originalGet(name)) as typeof customElements.get;
}
