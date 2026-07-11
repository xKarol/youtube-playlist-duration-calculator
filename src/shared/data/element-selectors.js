export const elementSelectors = {
  timestamp: "ytd-thumbnail-overlay-time-status-renderer",
  playlistMetadataRow:
    ".ytPageHeaderViewModelContent > .ytPageHeaderViewModelHeadline > div > yt-content-metadata-view-model > div:nth-child(2)",
  playlistActionRow: ".ytFlexibleActionsViewModelActionRow",
  video: "ytd-playlist-video-renderer",
  playlist: "ytd-playlist-video-list-renderer #contents",
  videoTitle: "#video-title",
  videoIndex: "yt-formatted-string#index",
  videoInfo: "yt-formatted-string#video-info",
};

export const desyncIndicators = {
  /**
   * Detects which YouTube playlist rendering architecture is currently active.
   *
   * Variants:
   * - "renderer": Traditional ytd-*-renderer CustomElements (e.g., Watch Later)
   * - "viewmodel": New yt-*-view-model + badge-shape architecture (e.g., Liked Videos)
   * - "unknown": Neither architecture detected
   *
   * @returns {{ known: boolean, variant: string }}
   */
  detectVariant(doc = document) {
    const checks = [
      {
        variant: "renderer",
        known: !!doc.querySelector("ytd-playlist-video-list-renderer"),
      },
      {
        variant: "viewmodel",
        known:
          !doc.querySelector("ytd-playlist-video-list-renderer") &&
          !!doc.querySelector("yt-lockup-view-model"),
      },
    ];

    const match = checks.find((check) => check.known);

    return match || { known: false, variant: "unknown" };
  },
};
