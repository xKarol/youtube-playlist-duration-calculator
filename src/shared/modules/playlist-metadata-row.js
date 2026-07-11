import { elementSelectors } from "../data/element-selectors";

const delimiterSelector = ".ytContentMetadataViewModelDelimiter";

export const resolvePlaylistMetadataRow = (doc, isVisible) => {
  const rows = [
    ...doc.querySelectorAll(elementSelectors.playlistMetadataRow),
  ].filter((row) => row.querySelector(delimiterSelector));

  return rows.find(isVisible) || rows[0] || null;
};
