export interface GitHubReleaseAsset {
  name?: string;
  browser_download_url?: string;
}

export interface GitHubRelease {
  tag_name?: string;
  html_url?: string;
  assets?: GitHubReleaseAsset[];
}

export function compareVersions(left: string, right: string): number {
  const parts = (value: string) => value.replace(/^v/, "").split(".").map((part) => Number(part) || 0);
  const a = parts(left), b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if ((a[index] || 0) === (b[index] || 0)) continue;
    return (a[index] || 0) > (b[index] || 0) ? 1 : -1;
  }
  return 0;
}

export function selectMacAsset(release: GitHubRelease, arch: string) {
  const normalizedArch = arch === "arm64" ? "arm64" : "x64";
  const version = String(release.tag_name || "").replace(/^v/, "");
  const expected = `Kocpy-${version}-${normalizedArch}.dmg`;
  const asset = (release.assets || []).find((candidate) => candidate.name === expected);
  return {
    arch: normalizedArch,
    archLabel: normalizedArch === "arm64" ? "Apple Silicon" : "Intel",
    assetName: asset?.name,
    downloadUrl: asset?.browser_download_url,
  };
}
