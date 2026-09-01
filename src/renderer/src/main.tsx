import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./style.css";
class Boundary extends React.Component<
  { children: React.ReactNode },
  { error: string }
> {
  state = { error: "" };
  static getDerivedStateFromError(e: Error) {
    return { error: e.message };
  }
  render() {
    return this.state.error ? (
      <div className="fatal">
        <h1>界面遇到了问题</h1>
        <p>{this.state.error}</p>
        <button className="btn primary" onClick={() => location.reload()}>
          重新加载工作台
        </button>
        <p>已启动的备份仍由后台管理。</p>
      </div>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById("root")!).render(
  <Boundary>
    <App />
  </Boundary>,
);
