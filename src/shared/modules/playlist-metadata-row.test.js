import assert from "node:assert";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import {
  resolveLegacyPlaylistMetadata,
  resolvePlaylistMetadataRow,
} from "./playlist-metadata-row.js";

const createDocument = () => {
  return new JSDOM(`
    <div class="ytPageHeaderViewModelContentMetadata">
      <div class="ytContentMetadataViewModelMetadataRow" data-row="author"></div>
      <div class="ytContentMetadataViewModelMetadataRow" data-row="hidden">
        <span class="ytContentMetadataViewModelDelimiter">•</span>
      </div>
      <div class="ytContentMetadataViewModelMetadataRow" data-row="visible">
        <span class="ytContentMetadataViewModelDelimiter">•</span>
      </div>
      <div class="ytContentMetadataViewModelMetadataRow" data-row="other"></div>
    </div>
  `).window.document;
};

describe("resolvePlaylistMetadataRow", () => {
  it("selects the visible delimiter-bearing metadata row", () => {
    const doc = createDocument();
    const row = resolvePlaylistMetadataRow(
      doc,
      (candidate) => candidate.dataset.row === "visible",
    );

    assert.strictEqual(row.dataset.row, "visible");
  });

  it("falls back to the first delimiter-bearing row", () => {
    const doc = createDocument();
    const row = resolvePlaylistMetadataRow(doc, () => false);

    assert.strictEqual(row.dataset.row, "hidden");
  });
});

describe("resolveLegacyPlaylistMetadata", () => {
  it("finds the legacy byline used by Watch Later", () => {
    const doc = new JSDOM(`
      <ytd-playlist-byline-renderer>
        <div class="metadata-stats" data-row="legacy">
          <yt-formatted-string class="byline-item">50 filmów</yt-formatted-string>
          <yt-formatted-string class="byline-item">Brak wyświetleń</yt-formatted-string>
        </div>
      </ytd-playlist-byline-renderer>
    `).window.document;

    const row = resolveLegacyPlaylistMetadata(doc, () => true);

    assert.strictEqual(row.dataset.row, "legacy");
  });
});
