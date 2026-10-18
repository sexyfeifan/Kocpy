import { api } from "./api";

export function AuthorFooter() {
  return <footer className="settings-author-footer" aria-label="作者与项目">
    <div><span className="muted small">作者与项目</span><strong>@sexyfeifan</strong></div>
    <nav aria-label="作者平台链接">
      <button onClick={() => void api.openAuthor("https://github.com/sexyfeifan")} aria-label="打开作者 GitHub 主页" title="GitHub · sexyfeifan">
        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58v-2.04c-3.34.73-4.04-1.42-4.04-1.42-.55-1.39-1.33-1.76-1.33-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.23 1.84 1.23 1.07 1.83 2.8 1.3 3.49.99.11-.78.42-1.3.76-1.6-2.66-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.53.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.63-5.49 5.93.43.37.82 1.1.82 2.22v3.29c0 .32.22.7.83.58A12 12 0 0 0 24 12.5C24 5.87 18.63.5 12 .5Z" /></svg><span>GitHub</span>
      </button>
      <button onClick={() => void api.openAuthor("https://www.xiaohongshu.com/user/profile/5d24d2ca000000001103fe97")} aria-label="打开作者小红书主页" title="小红书 · sexyfeifan"><img src="./xiaohongshu.png" alt="" /><span>小红书</span></button>
    </nav>
  </footer>;
}
