import { elementSelectors } from "../data/element-selectors";

const delimiterSelector = ".ytContentMetadataViewModelDelimiter";

export const resolvePlaylistMetadataRow = (doc, isVisible) => {
  const rows = [
    ...doc.querySelectorAll(elementSelectors.playlistMetadataRow),
  ].filter((row) => row.querySelector(delimiterSelector));

  return rows.find(isVisible) || rows[0] || null;
};

/**
 * Finds the metadata byline used by the legacy renderer layout. Watch Later
 * still uses this layout, unlike public playlists that use the page-header
 * view-model.
 */
export const resolveLegacyPlaylistMetadata = (doc, isVisible) => {
  const containers = [
    ...doc.querySelectorAll(elementSelectors.legacyPlaylistMetadata),
  ];

  return containers.find(isVisible) || containers[0] || null;
};
