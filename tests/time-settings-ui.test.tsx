import { describe, it, expect, vi } from "vitest";
vi.mock("../src/renderer/src/api", () => ({ api: { openAuthor: vi.fn() } }));
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectTimeSettings } from "../src/renderer/src/ProjectTimeSettings";
import { AuthorFooter } from "../src/renderer/src/AuthorFooter";

describe("time settings and secondary author links", () => {
  it("offers explicit project/day settings and never claims midnight filtering", () => {
    const html = renderToStaticMarkup(<ProjectTimeSettings value={{ projectTimeZone: "Asia/Shanghai", shootingDayBoundaryHour: 6, shootingDayTimeZones: { "2026-10-15": "Europe/Paris" } }} onChange={() => {}} />);
    expect(html).toContain("Europe/Paris"); expect(html).toContain("不改旧目录"); expect(html).toContain("不随午夜"); expect(html).toContain("只提示");
  });
  it("keeps unknown legacy settings blank instead of adding the workstation zone", () => {
    const html = renderToStaticMarkup(<ProjectTimeSettings value={{}} onChange={() => {}} />);
    expect(html).toContain('placeholder="未记录；请确认拍摄地" value=""');
  });
  it("renders accessible brand links only in the reusable Settings footer", () => {
    const html = renderToStaticMarkup(<AuthorFooter />);
    expect(html).toContain('class="settings-author-footer"'); expect(html).toContain('aria-label="打开作者 GitHub 主页"'); expect(html).toContain('aria-label="打开作者小红书主页"'); expect(html).toContain("<svg"); expect(html).toContain("xiaohongshu.png");
  });
});
