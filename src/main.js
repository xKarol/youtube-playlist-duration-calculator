import { discoverPlaylist } from "./modules/discovery/orchestrator";
import { computeMaxError } from "./modules/extraction/error-bound";
import { extractTimestamp } from "./modules/extraction/orchestrator";
import { extractPlaylistCount } from "./modules/extraction/playlist-count-extraction";
import { isRemovalMutation } from "./modules/reactivity/mutation-shape";
import { PlaylistSorter } from "./modules/sorting";
import {
  desyncIndicators,
  elementSelectors,
} from "./shared/data/element-selectors";
import { logger } from "./shared/modules/logger";
import { isOperablePlaylistPage } from "./shared/modules/page-guard";
import { isSortingEnabledForCount } from "./shared/modules/sort-cap";
import {
  convertSecondsToShortDuration,
  convertSecondsToTimestamp,
  getTimestampFromVideo,
} from "./shared/modules/timestamp";
import "./main.css";

let activePlaylistInterval = null;

const main = () => {
  try {
    setupPage();
    checkPlaylistReady();
  } catch (error) {
    logger.error("main_failed", error.message);
  }
};

const checkPlaylistReady = () => {
  logger.debug("Checking if playlist is ready to be processed");

  if (activePlaylistInterval) {
    clearInterval(activePlaylistInterval);
  }

  const maxPollCount = 60;
  let pollCount = 0;
  let lastPathname = window.location.pathname;

  activePlaylistInterval = setInterval(() => {
    // When the pathname changes between ticks (SPA transition), the DOM
    // is still transitioning. Skip this tick to give YouTube's renderer
    // time to stabilise. The next tick runs against the fully-loaded page.
    const currentPathname = window.location.pathname;

    if (currentPathname !== lastPathname) {
      lastPathname = currentPathname;
      pollCount = 0;
      return;
    }
    // Stop polling once maxPollCount is reached. The first tick at
    // pollCount === maxPollCount clears the interval. Subsequent ticks
    // short-circuit before doing any work, so the loop neither fires
    // readiness checks nor queries the DOM after the budget is
    // exhausted. Without this guard the interval would keep running
    // every second forever, re-querying selectors on a page that will
    // never reach readiness.
    if (pollCount >= maxPollCount) {
      clearInterval(activePlaylistInterval);
      activePlaylistInterval = null;
      return;
    }

    const playlistElement = document.querySelector(elementSelectors.playlist);
    const playlistExists = playlistElement !== null;
    const variant = desyncIndicators.detectVariant();

    logger.debug("poll_tick", () => ({
      pollCount,
      playlistExists,
      playlistVisible: playlistExists
        ? isElementVisible(playlistElement)
        : null,
      pathname: window.location.pathname,
      variant: variant.variant,
      variantKnown: variant.known,
    }));

    // Non-operable pages (anything other than /playlist) stop silently.
    // This includes /feed/playlists, /watch, /feed/history, and channel
    // pages. The structural protection against inserting on a non-playlist
    // page lives in `isOperablePlaylistPage()` at the processPlaylist /
    // displayLoader call sites. This branch simply ends polling without
    // signaling failure. The unknown-variant branch above handles that.
    if (shouldStopPollingSilently({ pollCount, playlistExists, variant })) {
      clearInterval(activePlaylistInterval);
      activePlaylistInterval = null;
      return;
    }

    // Viewmodel desync on a playlist page is expected, not a failure.
    // Log it and let polling continue rather than signaling failure.
    if (isViewmodelDesyncCheckpoint({ pollCount, playlistExists, variant })) {
      logger.info("desync_viewmodel_detected", () => ({
        pollCount,
        variant: variant.variant,
        pathname: window.location.pathname,
      }));
    }

    const discoveryResult = maybeRunInvariantSearch({
      pollCount,
      playlistExists,
      variant,
    });

    // Renderer-architecture readiness: the playlist element exists, the
    // timestamp element resolves, and the unavailable counts agree. The
    // visibility check applies here because `playlistElement` is a real
    // DOM element that could be rendered hidden (e.g., during a SPA
    // transition where the selector still resolves but the container
    // is being torn down).
    if (playlistExists && isRendererReady()) {
      clearInterval(activePlaylistInterval);
      activePlaylistInterval = null;

      const playlistVisible = isElementVisible(playlistElement);

      logger.debug("playlist_ready_check", () => ({
        pollCount,
        playlistVisible,
        unavailableTimestampsCount: countVideosWithoutExtractableTimestamp(),
        unavailableVideosCount: countVideosFlaggedUnavailable(),
        playlistOffsetHeight: playlistElement?.offsetHeight,
        playlistOffsetWidth: playlistElement?.offsetWidth,
      }));

      if (playlistVisible) {
        processPlaylist();
      } else {
        logger.debug("playlist_not_visible_skipping", () => ({
          pollCount,
          offsetParent: playlistElement?.offsetParent?.tagName,
          display: playlistElement
            ? getComputedStyle(playlistElement).display
            : null,
          visibility: playlistElement
            ? getComputedStyle(playlistElement).visibility
            : null,
        }));
      }
    }

    // ViewModel-architecture readiness: discovery produced a confident
    // result and a sample of the discovered videos yields extractable
    // timestamps. There is no `playlistElement` on this architecture,
    // so the renderer-branch visibility check does not apply. Call
    // processPlaylist directly. The `!playlistExists` guard preserves
    // the mutual exclusivity of the two readiness paths: if the renderer
    // selector resolved but readiness failed (e.g., counts disagree
    // mid-render), we keep polling rather than falling through to the
    // viewmodel path on a potentially stale discoveryResult.
    else if (!playlistExists && isViewmodelReady()) {
      clearInterval(activePlaylistInterval);
      activePlaylistInterval = null;

      logger.debug("viewmodel_ready_check", () => ({
        pollCount,
        videoCount: discoveryResult?.videos?.length || 0,
        confidence: discoveryResult?.confidence,
        hasTimestamps: true,
      }));

      processPlaylist();
    }

    pollCount++;
  }, 1000);
};

/**
 * Whether the readiness loop should stop polling silently (no failure UI).
 *
 * Fires when the variant is known but the page is not operable (e.g.,
 * /feed/playlists, /watch). The unknown-variant branch above handles
 * failure signaling. This branch simply ends the loop.
 */
const shouldStopPollingSilently = ({ pollCount, playlistExists, variant }) => {
  return (
    pollCount > 15 &&
    !playlistExists &&
    variant.known &&
    !isOperablePlaylistPage()
  );
};

/**
 * Whether this tick is the viewmodel desync checkpoint (pollCount === 15).
 *
 * Used to emit a one-time informational log when the known selector has
 * not matched but the viewmodel variant is detected. Polling continues.
 */
const isViewmodelDesyncCheckpoint = ({
  pollCount,
  playlistExists,
  variant,
}) => {
  return (
    pollCount === 15 &&
    !playlistExists &&
    variant.known &&
    variant.variant === "viewmodel"
  );
};

/**
 * Run the structural-invariant discovery search if applicable on this tick.
 *
 * Invariant search handles viewmodel and any future variant when the
 * known selector misses. Runs at most once: the guard on
 * `window.ytpdc.discoveryResult` prevents re-entry on subsequent ticks.
 * Returns the live `discoveryResult` (existing or newly assigned).
 */
const maybeRunInvariantSearch = ({ pollCount, playlistExists, variant }) => {
  if (
    !playlistExists &&
    variant.known &&
    isOperablePlaylistPage() &&
    pollCount >= (variant.variant === "viewmodel" ? 2 : 10) &&
    !window.ytpdc?.discoveryResult
  ) {
    const discoveryResult = discoverPlaylist(document, variant);

    logger.debug("invariant_search", () => ({
      pollCount,
      variant: variant.variant,
      confidence: discoveryResult.confidence,
      strategy: discoveryResult.strategy,
      hasContainer: !!discoveryResult.container,
      videoCount: discoveryResult.videos?.length || 0,
    }));

    if (discoveryResult.confidence > 0) {
      window.ytpdc.discoveryResult = discoveryResult;
    }
  }

  return window.ytpdc?.discoveryResult;
};

/**
 * Renderer-architecture readiness: playlist element exists, timestamp
 * selector resolves, and the "no extractable timestamp" count agrees
 * with the "flagged unavailable" count.
 */
const isRendererReady = () => {
  const timestampElement = document.querySelector(elementSelectors.timestamp);
  const timestampExists = timestampElement !== null;

  if (!timestampExists) {
    return false;
  }

  const unavailableTimestampsCount = countVideosWithoutExtractableTimestamp();
  const unavailableVideosCount = countVideosFlaggedUnavailable();

  return unavailableTimestampsCount === unavailableVideosCount;
};

/**
 * ViewModel-architecture readiness: discovery produced a confident
 * result and a sample of the discovered videos yields at least one
 * extractable timestamp. Excludes the renderer case where the playlist
 * selector already matches.
 */
const isViewmodelReady = () => {
  const discoveryResult = window.ytpdc?.discoveryResult;

  if (!discoveryResult || discoveryResult.confidence <= 0.5) {
    return false;
  }

  if (!isOperablePlaylistPage()) {
    return false;
  }

  const sampleVideos = discoveryResult.videos?.slice(0, 3) || [];

  return sampleVideos.some((v) => {
    const result = extractTimestamp(v);
    return result.seconds !== null && result.confidence > 0;
  });
};

const setupPage = () => {
  if (window.ytpdc?.pageSetupDone) return;

  window.ytpdc = {
    pageSetupDone: false,
    playlistObserver: null,
    sortDropdown: {
      used: false,
      element: null,
    },
    lastVideoInteractedWith: null,
  };

  const onYoutubeNavigationFinished = () => {
    logger.debug("yt_navigation_finished", () => ({
      pathname: window.location.pathname,
      search: window.location.search,
    }));

    document.removeEventListener(
      "yt-navigate-finish",
      onYoutubeNavigationFinished,
      false,
    );

    window.ytpdc.playlistObserver?.disconnect();

    removeDurationSpan();
    removeSortButton();

    window.ytpdc = {
      pageSetupDone: false,
      playlistObserver: null,
      sortDropdown: {
        used: false,
        element: null,
      },
      lastVideoInteractedWith: null,
    };

    main();
  };

  document.addEventListener(
    "yt-navigate-finish",
    onYoutubeNavigationFinished,
    false,
  );

  const onPlaylistInteractedWith = (event) => {
    window.ytpdc.lastVideoInteractedWith = event.target.closest(
      elementSelectors.video,
    );
  };

  // Listen on the live playlist container across both architectures.
  // On the viewmodel architecture `elementSelectors.playlist` does not
  // match, so fall back to the discovered insertion container.
  const interactionTarget =
    document.querySelector(elementSelectors.playlist) ||
    window.ytpdc?.discoveryResult?.videos?.[0]?.parentElement;

  interactionTarget?.addEventListener("click", onPlaylistInteractedWith);

  window.ytpdc.pageSetupDone = true;
};

/**
 * Checks whether a given element is visible to the browser
 *
 * Ref:
 * - https://developer.mozilla.org/en-US/docs/Web/API/Element/checkVisibility
 * - https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/offsetParent
 *
 * @param {Element} element
 */
const isElementVisible = (element) => {
  if (!element) return false;

  return (
    element?.offsetParent !== null ||
    element?.checkVisibility({
      contentVisibilityAuto: true,
      opacityProperty: true,
      visibilityProperty: true,
    })
  );
};

const getDurationSpanElement = () => {
  return document.querySelector("#ytpdc-duration-span");
};

const removeDurationSpan = () => {
  getDurationSpanElement()?.remove();
};

const removeSortButton = () => {
  document.querySelector("#ytpdc-sort-button")?.remove();
};

/**
 * Counts videos whose timestamp could not be extracted.
 *
 * This is the BROAD notion of "unavailable", includes unavailable,
 * live, upcoming, and badge-absent videos. Distinct from
 * `countVideosFlaggedUnavailable`, which is the narrow title-based
 * predicate. The readiness invariant `countWithout === countFlagged`
 * means: every video without an extractable timestamp is also flagged
 * unavailable (no "extraction-failed-but-not-flagged-unavailable"
 * stragglers indicating the page is mid-render).
 */
const countVideosWithoutExtractableTimestamp = () => {
  return getVideos()
    .map(getTimestampFromVideo)
    .filter((timestamp) => timestamp === null).length;
};

/**
 * Returns a list of video elements found within the playlist element
 * @returns {Element[]}
 **/
const getVideos = () => {
  const discoveryResult = window.ytpdc?.discoveryResult;

  // ViewModel architecture: re-derive the live lockup children from the
  // insertion container at call time. `discoveryResult.videos` is a frozen
  // snapshot from discovery and would not include scroll-appended lockups,
  // so it must not be returned directly. The snapshot's role is to identify
  // the container and the video selector, not to cache the video list.
  //
  // The insertion container is NOT `videos[0].parentElement`: each
  // lockup is wrapped in its own per-video div that holds exactly one
  // lockup. The shared container that holds all lockups is reached via
  // `closest('#contents')` from any snapshot lockup.
  if (discoveryResult?.videos?.length > 0) {
    const videoSelector =
      discoveryResult.videoSelector || "yt-lockup-view-model";
    const firstSnapshot = discoveryResult.videos[0];
    const liveContainer =
      firstSnapshot?.closest("#contents") || firstSnapshot?.parentElement;

    if (liveContainer) {
      const liveVideos = liveContainer.querySelectorAll(videoSelector);

      if (liveVideos.length > 0) {
        return [...liveVideos];
      }
    }
  }

  // Renderer-invariant: use discovered container, extract by tag name
  if (discoveryResult?.container) {
    const container = discoveryResult.container;
    const videos = container.getElementsByTagName(elementSelectors.video);

    if (videos.length > 0) {
      return [...videos];
    }
  }

  // Fallback: use the known renderer selector
  const playlistElement = document.querySelector(elementSelectors.playlist);

  if (!playlistElement) {
    return [];
  }

  const videos = playlistElement.getElementsByTagName(elementSelectors.video);
  return [...videos];
};

/**
 * Counts videos flagged unavailable by the narrow predicate:
 * no extractable timestamp OR unavailable title.
 *
 * Distinct from `countVideosWithoutExtractableTimestamp` (the broad
 * count). The readiness invariant `countWithout === countFlagged` means:
 * every video without an extractable timestamp is also flagged
 * unavailable.
 */
const countVideosFlaggedUnavailable = () => {
  return getVideos().filter(isVideoUnavailable).length;
};

/**
 * Checks whether a given video element meets the criteria for being considered
 * "unavailable"
 *
 * Criteria:
 * - Has no extractable timestamp (architecture-agnostic check. Works on
 *   both renderer `ytd-*-renderer` and viewmodel `yt-lockup-view-model`
 *   via the shared `getTimestampFromVideo` helper, which has both the
 *   known-selector path and the content-pattern fallback)
 * - Title is unavailable
 *
 * @param {Element} video
 */
const isVideoUnavailable = (video) => {
  const hasNoTimestamp = getTimestampFromVideo(video) === null;

  if (hasNoTimestamp) return true;

  const hasUnavailableTitle = [
    chrome.i18n.getMessage("videoTitle_private"),
    chrome.i18n.getMessage("videoTitle_deleted"),
    chrome.i18n.getMessage("videoTitle_unavailable_v1"),
    chrome.i18n.getMessage("videoTitle_unavailable_v2"),
    chrome.i18n.getMessage("videoTitle_restricted"),
    chrome.i18n.getMessage("videoTitle_ageRestricted"),
  ].includes(getVideoTitle(video));

  if (hasUnavailableTitle) return true;

  return false;
};

/**
 * @param {Element} video
 * @returns {string | undefined}
 */
const getVideoTitle = (video) => {
  return video.querySelector(elementSelectors.videoTitle)?.title;
};

const processPlaylist = () => {
  // Defense-in-depth at processPlaylist itself: the discovery branch of
  // checkPlaylistReady already gates on `pathname === "/playlist"`, but
  // the renderer branch via `isRendererReady()` does not. The renderer
  // branch fires during SPA transition windows where the URL has flipped
  // to a
  // non-playlist URL but the prior page's playlist DOM has not yet been
  // torn down. The playlist selector still resolves, so the gate here is
  // load-bearing, not redundant. See shared/modules/page-guard.js.
  if (!isOperablePlaylistPage()) {
    logger.debug("processPlaylist_skipped_non_operable", () => ({
      pathname: window.location.pathname,
    }));
    return;
  }

  logger.debug("processing_playlist");

  const playlistObserver = setupPlaylistObserver();
  const videos = getVideos();

  const timestamps = [];
  const extractionResults = [];
  let nullTimestamps = 0;
  let highConfidenceCount = 0;
  let lowConfidenceCount = 0;
  let totalDurationInSeconds = 0;

  for (const video of videos) {
    const result = extractTimestamp(video);

    timestamps.push(result.seconds);
    extractionResults.push(result);

    if (result.seconds === null) {
      nullTimestamps++;
      continue;
    }

    totalDurationInSeconds += result.seconds;

    if (result.confidence >= 0.8) {
      highConfidenceCount++;
    } else {
      lowConfidenceCount++;
    }
  }

  const playlistDuration = convertSecondsToTimestamp(totalDurationInSeconds);

  // Verified videos contribute zero. Unparseable videos are excluded
  // (they surface in "Videos not counted"). The bound is per-token-shape,
  // not a flat per-video constant.
  const maxErrorSeconds = computeMaxError(extractionResults);

  logger.debug("playlist_calculated", () => ({
    videoCount: videos.length,
    timestampCount: timestamps.length,
    nullTimestamps,
    highConfidence: highConfidenceCount,
    lowConfidence: lowConfidenceCount,
    maxErrorSeconds,
    totalDurationInSeconds,
    playlistDuration,
  }));

  addPlaylistSummaryToPage({
    timestamps,
    lowConfidenceCount,
    playlistObserver,
  });
};

/**
 * Resolves the live DOM element that YouTube inserts new video elements
 * into, regardless of rendering architecture.
 *
 * Priority:
 *   1. The renderer selector (`ytd-playlist-video-list-renderer #contents`)
 *      for the renderer architecture.
 *   2. The direct-insertion parent of the discovered viewmodel lockups
 *      (`discoveryResult.videos[0].parentElement`), i.e. the `#contents`
 *      div inside `yt-section-list-renderer` that YouTube appends lockups
 *      into. This is where `childList` mutations actually fire on scroll.
 *   3. The discovered container as a fallback.
 *
 * Without step 2 the observer is never attached on the viewmodel
 * architecture, so scroll-triggered appends go undetected.
 *
 * @returns {Element | null}
 */
const resolveObserverTarget = () => {
  const rendererElement = document.querySelector(elementSelectors.playlist);

  if (rendererElement) {
    return rendererElement;
  }

  const discoveryResult = window.ytpdc?.discoveryResult;

  if (!discoveryResult) {
    return null;
  }

  // ViewModel architecture: the live container that YouTube appends
  // lockups into. Each lockup is wrapped in its own per-video div, so
  // `videos[0].parentElement` is NOT the insertion container (it holds
  // exactly one lockup). The shared insertion container is reached via
  // `closest('#contents')` from any snapshot lockup. Falling back to
  // `discoveryResult.container` covers any discovered ancestor.
  if (discoveryResult.videos?.length > 0) {
    const firstSnapshot = discoveryResult.videos[0];
    const insertionContainer =
      firstSnapshot?.closest("#contents") ||
      firstSnapshot?.parentElement ||
      discoveryResult.container;

    if (insertionContainer) {
      return insertionContainer;
    }
  }

  return discoveryResult.container || null;
};

/**
  * Sets up a mutation observer on the playlist to detect when video(s) are
  * added or removed.
  * Upon detection it conditionally triggers a re-processing of the playlist
  * @returns {{
      disconnect: () => void,
      reconnect: () => void
    } | null}
  */
const setupPlaylistObserver = () => {
  if (window.ytpdc.playlistObserver) {
    logger.debug("playlist_observer_reused");
    return window.ytpdc.playlistObserver;
  }

  const playlistElement = resolveObserverTarget();

  if (!playlistElement) {
    logger.debug("playlist_observer_no_element");
    return null;
  }

  const playlistObserver = new MutationObserver(onPlaylistMutated);

  playlistObserver.observe(playlistElement, { childList: true });

  window.ytpdc.playlistObserver = playlistObserver;

  logger.debug("playlist_observer_created", () => ({
    playlistChildCount: playlistElement.childElementCount,
    observerTargetTag: playlistElement.tagName,
    observerTargetId: playlistElement.id || null,
  }));

  return {
    disconnect: () => playlistObserver.disconnect(),
    reconnect: () =>
      playlistObserver.observe(playlistElement, { childList: true }),
  };
};

/**
 * Decide whether a single `childList` mutation is a user-initiated
 * video removal (possibly after sorting), as opposed to a lazy-load
 * append or any other shape.
 *
 * Delegates to the pure classifier in `mutation-shape.js` so the
 * indivisible map/territory decision is unit-testable without dragging
 * in the content-script entry point (which imports CSS).
 *
 * @param {MutationRecord} mutation
 * @returns {boolean}
 */
const isUserRemovalMutation = (mutation) =>
  isRemovalMutation(mutation, {
    videoTag: elementSelectors.video,
    lastInteracted: window.ytpdc?.lastVideoInteractedWith,
  });

/**
 * This function decides when the playlist duration should be recalculated & how
 *
 * Mutations are classified by their physical shape, not by their record count:
 *
 * 1. Page-reload case (`shouldRequestPageReload`): display the reload prompt,
 *    disconnect, return. Unchanged.
 * 2. User-removal case: exactly one removed video renderer and a recorded
 *    last-interacted video. Re-add the wrong-removed video (post-sort fixup),
 *    remove the interaction marker, re-arm the observer, recompute.
 * 3. Append case (`addedNodes.length > 0`, `removedNodes.length === 0`):
 *    YouTube lazily loaded more videos because the user scrolled. Do not touch
 *    the DOM. Re-arm the observer on the live playlist container and recompute.
 * 4. Any other shape: recompute.
 *
 * @param {MutationRecord[]} mutationList
 * @param {MutationObserver} observer
 * @returns {void | undefined}
 */
const onPlaylistMutated = (mutationList, observer) => {
  const playlistElement = resolveObserverTarget();

  logger.debug("playlist_mutated", () => ({
    mutationCount: mutationList.length,
    types: mutationList.map((m) => m.type),
    addedTotal: mutationList.reduce((n, m) => n + m.addedNodes.length, 0),
    removedTotal: mutationList.reduce((n, m) => n + m.removedNodes.length, 0),
    lastVideoInteracted: !!window.ytpdc.lastVideoInteractedWith,
  }));

  if (mutationList.length === 1 && mutationList[0].type === "childList") {
    const mutation = mutationList[0];

    // User-initiated removal (possibly post-sort): re-add the wrong-removed
    // video before recomputing. This branch is only correct when a video was
    // actually removed AND the user has a recorded last-interacted video;
    // `isUserRemovalMutation` encodes both so we never dereference a null
    // `lastVideoInteractedWith` on a lazy-load append mutation.
    if (isUserRemovalMutation(mutation)) {
      const removedVideo = mutation.removedNodes[0];
      const lastInteracted = window.ytpdc.lastVideoInteractedWith;

      // If the playlist was sorted, YouTube removes the wrong video from
      // the playlist UI. The correct video is removed by the server.
      if (getVideoTitle(removedVideo) !== getVideoTitle(lastInteracted)) {
        if (mutation.previousSibling) {
          mutation.previousSibling.after(removedVideo);
        } else if (mutation.nextSibling) {
          mutation.nextSibling.before(removedVideo);
        }
      }

      observer.disconnect();

      lastInteracted.remove();

      observer.observe(playlistElement, { childList: true });

      main();

      return;
    }

    // Lazy-load append (or any other single childList mutation that is
    // not a page reload and not a user removal). Do not modify the DOM,
    // in contrast with the removal branch above.
    observer.disconnect();
    observer.observe(playlistElement, { childList: true });
    main();
  } else {
    main();
  }
};

const addSortButtonToActionRow = (playlistObserver) => {
  removeSortButton();

  const totalVideos = countTotalVideosInPlaylist();

  if (!isSortingEnabledForCount(totalVideos)) {
    return;
  }

  const actionRow = document.querySelector(elementSelectors.playlistActionRow);

  if (!actionRow) {
    logger.debug("action_row_not_found");
    return;
  }

  const sortButton = createSortIconButton(playlistObserver);

  const lastChild = actionRow.lastElementChild;

  if (lastChild) {
    actionRow.insertBefore(sortButton, lastChild);
  } else {
    actionRow.appendChild(sortButton);
  }

  logger.debug("inserted_sort_button", () => ({
    actionRowTag: actionRow.tagName,
    actionRowClasses: actionRow.className,
  }));
};

const createSortIconButton = (playlistObserver) => {
  const wrapper = document.createElement("div");
  wrapper.classList.add(
    "ytFlexibleActionsViewModelAction",
    "ytFlexibleActionsViewModelActionRowAction",
    "ytFlexibleActionsViewModelActionIconOnlyButton",
  );

  const buttonViewModel = document.createElement("button-view-model");
  buttonViewModel.classList.add("ytSpecButtonViewModelHost");

  const button = document.createElement("button");
  button.id = "ytpdc-sort-button";
  button.classList.add(
    "ytSpecButtonShapeNextHost",
    "ytSpecButtonShapeNextTonal",
    "ytSpecButtonShapeNextOverlay",
    "ytSpecButtonShapeNextSizeM",
    "ytSpecButtonShapeNextIconButton",
    "ytSpecButtonShapeNextEnableBackdropFilterExperiment",
  );
  button.title = chrome.i18n.getMessage("sortDropdown_label");
  button.setAttribute(
    "aria-label",
    chrome.i18n.getMessage("sortDropdown_label"),
  );
  button.setAttribute("aria-disabled", "false");

  const iconWrapper = document.createElement("div");
  iconWrapper.classList.add(
    "ytSpecButtonShapeNextIcon",
    "ytSpecButtonShapeNextElevatedContent",
  );
  iconWrapper.setAttribute("aria-hidden", "true");

  const iconHost = document.createElement("span");
  iconHost.classList.add("ytIconWrapperHost");
  iconHost.style.width = "24px";
  iconHost.style.height = "24px";

  const iconShape = document.createElement("span");
  iconShape.classList.add("yt-icon-shape", "ytSpecIconShapeHost");

  const iconDiv = document.createElement("div");
  iconDiv.style.width = "100%";
  iconDiv.style.height = "100%";
  iconDiv.style.display = "block";
  iconDiv.style.fill = "currentcolor";

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("height", "24");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "24");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("aria-hidden", "true");
  svg.style.pointerEvents = "none";
  svg.style.display = "inherit";
  svg.style.width = "100%";
  svg.style.height = "100%";
  svg.innerHTML = `<path d="M3 18h6v-2H3v2zM3 6v2h18V6H3zm0 7h12v-2H3v2z"/>`;

  iconDiv.appendChild(svg);
  iconShape.appendChild(iconDiv);
  iconHost.appendChild(iconShape);
  iconWrapper.appendChild(iconHost);

  const touchFeedback = document.createElement("yt-touch-feedback-shape");
  touchFeedback.setAttribute("aria-hidden", "true");
  touchFeedback.classList.add(
    "ytSpecTouchFeedbackShapeHost",
    "ytSpecTouchFeedbackShapeOverlayTouchResponse",
  );

  const touchStroke = document.createElement("div");
  touchStroke.classList.add("ytSpecTouchFeedbackShapeStroke");
  const touchFill = document.createElement("div");
  touchFill.classList.add("ytSpecTouchFeedbackShapeFill");
  touchFeedback.appendChild(touchStroke);
  touchFeedback.appendChild(touchFill);

  button.appendChild(iconWrapper);
  button.appendChild(touchFeedback);

  const sortDropdown = createSortDropdown(playlistObserver);

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    sortDropdown.classList.toggle("ytpdc-hidden");
  });

  document.addEventListener("click", () => {
    sortDropdown.classList.add("ytpdc-hidden");
  });

  buttonViewModel.appendChild(button);
  wrapper.appendChild(buttonViewModel);
  wrapper.appendChild(sortDropdown);

  return wrapper;
};

const createSortDropdown = (playlistObserver) => {
  const dropdown = document.createElement("div");
  dropdown.id = "ytpdc-sort-dropdown";
  dropdown.classList.add("ytpdc-hidden");

  const sortOptions = PlaylistSorter.getSortOptions();

  sortOptions.forEach((sortOption) => {
    dropdown.appendChild(sortOption);
  });

  dropdown.addEventListener("click", (event) => {
    if (
      !event.target.classList.contains("ytpdc-sort-control-dropdown-option")
    ) {
      return;
    }

    window.ytpdc.sortDropdown.used = true;

    dropdown.classList.add("ytpdc-hidden");

    playlistObserver?.disconnect();

    const videos = getVideos();
    const playlistElement = resolveObserverTarget();

    if (!playlistElement || videos.length === 0) {
      return;
    }

    const playlistSorter = new PlaylistSorter(
      event.target.getAttribute("value"),
    );
    const sortedVideos = playlistSorter.sort(videos.slice(0, 100));

    playlistElement.replaceChildren(...sortedVideos);

    playlistObserver?.reconnect();
  });

  return dropdown;
};

const countTotalVideosInPlaylist = () => {
  const result = extractPlaylistCount(document);
  return result.value;
};

const addPlaylistSummaryToPage = ({
  timestamps,
  lowConfidenceCount,
  playlistObserver,
}) => {
  removeDurationSpan();

  const metadataRow = document.querySelector(
    elementSelectors.playlistMetadataRow,
  );

  if (!metadataRow) {
    logger.debug("metadata_row_not_found");
    return;
  }

  const isApproximate = lowConfidenceCount > 0;
  const totalSeconds = timestamps.reduce((sum, ts) => sum + (ts ?? 0), 0);
  const shortDuration = convertSecondsToShortDuration(totalSeconds);
  const durationText = isApproximate ? `~${shortDuration}` : shortDuration;

  const delimiter = document.createElement("span");
  delimiter.setAttribute("aria-hidden", "true");
  delimiter.className = "ytContentMetadataViewModelDelimiter";
  delimiter.textContent = "•";

  const durationSpan = document.createElement("span");
  durationSpan.id = "ytpdc-duration-span";
  durationSpan.className =
    "ytAttributedStringHost ytContentMetadataViewModelMetadataText ytAttributedStringWhiteSpacePreWrap ytAttributedStringLinkInheritColor";
  durationSpan.setAttribute("dir", "auto");
  durationSpan.setAttribute("role", "text");
  durationSpan.textContent = durationText;

  metadataRow.appendChild(delimiter);
  metadataRow.appendChild(durationSpan);

  addSortButtonToActionRow(playlistObserver);

  logger.debug("inserted_duration_span", () => ({
    durationText,
    isApproximate,
    metadataRowTag: metadataRow.tagName,
    metadataRowClasses: metadataRow.className,
  }));
};

const start = () => {
  logger.info("Loaded.");
  main();
};

if (document.readyState !== "loading") {
  start();
} else {
  document.addEventListener("DOMContentLoaded", start);
}
