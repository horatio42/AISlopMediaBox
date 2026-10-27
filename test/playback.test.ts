import { after, before, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  adminClient,
  assert,
  createLibrary,
  makeAudioTrack,
  makeImage,
  makeSrt,
  makeVideo,
  newUserClient,
  scanLibrary,
  startServer,
  writeNfo,
} from './helpers.ts';
import type { Client, Library, StartedServer } from './helpers.ts';

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

interface AudioTrackInfo {
  index: number;
  codec: string;
  channels: number | null;
  language: string;
  title: string | null;
  default: boolean;
  selected: boolean;
}

interface SubtitleInfo {
  id: number;
  language: string;
  label: string;
  format: string;
  forced: number;
  isExternal: boolean;
  streamIndex: number | null;
  url: string;
}

interface StreamInfo {
  id: number;
  kind: string;
  title: string;
  directPlay: boolean;
  mode: string;
  reasons: string[];
  container: string;
  videoCodec: string;
  audioCodec: string;
  width: number | null;
  height: number | null;
  duration: number;
  sizeBytes: number | null;
  audioTracks: AudioTrackInfo[];
  selectedAudio: number | null;
  subtitles: SubtitleInfo[];
  selectedSubtitle: number | null;
  burn: boolean;
  start: number;
  directUrl: string;
  hlsUrl: string | null;
  transcode: {
    available: boolean; enabled: boolean; active: number; limit: number; height: number; preset: string;
    segmentSeconds: number; mode: string; throttleSeconds: number;
    hardware: { kind: string; encoder: string; device: string | null; active: boolean };
    hwaccel: { preference: string; device: string; available: Array<{ kind: string; encoder: string; device: string | null; label: string }> };
  };
}

interface MediaItem {
  id: number;
  kind: string;
  title: string;
  container?: string;
  playable: boolean;
}

interface PagedItems<T> {
  items: T[];
  total: number;
}

let server: StartedServer;
let admin: Client;
let regular: Client;
let moviesLibrary: Library;
let directMovieId: number;
let transcodeMovieId: number;
let directMoviePath: string;
let showId: number;
let photoId: number;
let trackId: number;

before(async () => {
  server = await startServer();
  admin = await adminClient(server);
  regular = await newUserClient(server, admin, 'playback_user', 'user');

  const moviesRoot = path.join(server.mediaDir, 'movies');
  const directDir = path.join(moviesRoot, 'Direct Slop (2020)');
  directMoviePath = makeVideo(path.join(directDir, 'Direct Slop (2020).mp4'));
  writeNfo(path.join(directDir, 'movie.nfo'), 'movie', {
    title: 'Direct Slop',
    year: 2020,
    plot: 'Direct play or bust.',
    genres: ['Action'],
  });
  makeSrt(path.join(directDir, 'Direct Slop (2020).en.srt'));
  makeSrt(path.join(directDir, 'Direct Slop (2020).forced.srt'));

  const transcodeDir = path.join(moviesRoot, 'Transcode Slop (2021)');
  makeVideo(path.join(transcodeDir, 'Transcode Slop (2021).mkv'));
  writeNfo(path.join(transcodeDir, 'movie.nfo'), 'movie', { title: 'Transcode Slop', year: 2021, plot: 'Needs transcoding.', genres: ['Action'] });

  const showDir = path.join(server.mediaDir, 'shows', 'Playback Show (2022)');
  writeNfo(path.join(showDir, 'tvshow.nfo'), 'tvshow', { title: 'Playback Show', year: 2022, plot: 'Containers.', genres: ['Drama'] });
  makeVideo(path.join(showDir, 'Season 01', 'Playback Show - S01E01 - Pilot.mp4'));

  makeAudioTrack(path.join(server.mediaDir, 'music', 'Player', 'Audio Album (2000)', '01 - Audio Track.mp3'), {
    title: 'Audio Track',
    genre: 'Ambient',
    track: 1,
  });
  makeImage(path.join(server.mediaDir, 'photos', 'frame.jpg'), '0xabcdef');

  moviesLibrary = await createLibrary(admin, { name: 'Movies', kind: 'movies', path: moviesRoot });
  const showsLibrary = await createLibrary(admin, { name: 'Shows', kind: 'shows', path: path.join(server.mediaDir, 'shows') });
  const musicLibrary = await createLibrary(admin, { name: 'Music', kind: 'music', path: path.join(server.mediaDir, 'music') });
  const photosLibrary = await createLibrary(admin, { name: 'Photos', kind: 'photos', path: path.join(server.mediaDir, 'photos') });

  await scanLibrary(admin, moviesLibrary.id);
  await scanLibrary(admin, showsLibrary.id);
  await scanLibrary(admin, musicLibrary.id);
  await scanLibrary(admin, photosLibrary.id);

  const movies = await admin.get<PagedItems<MediaItem>>(`/api/libraries/${moviesLibrary.id}/items`);
  directMovieId = movies.json!.items.find((item) => item.title === 'Direct Slop')!.id;
  transcodeMovieId = movies.json!.items.find((item) => item.title === 'Transcode Slop')!.id;
  const shows = await admin.get<PagedItems<MediaItem>>(`/api/libraries/${showsLibrary.id}/items`);
  showId = shows.json!.items[0].id;
  const music = await admin.get<PagedItems<MediaItem>>(`/api/libraries/${musicLibrary.id}/items?kind=album`);
  assert.ok(music.json!.items.length === 1);
  const albumDetail = await admin.get<{ tracks: MediaItem[] }>(`/api/media/${music.json!.items[0].id}`);
  trackId = albumDetail.json!.tracks[0].id;
  const photos = await admin.get<PagedItems<MediaItem>>(`/api/libraries/${photosLibrary.id}/items`);
  photoId = photos.json!.items[0].id;
});

after(async () => {
  await server.stop();
});

test('stream info declares direct play only for browser-safe mp4/aac', async () => {
  const response = await regular.get<StreamInfo>(`/api/stream/${directMovieId}/info`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const info = response.json!;
  assert.equal(info.id, directMovieId);
  assert.equal(info.kind, 'movie');
  assert.equal(info.title, 'Direct Slop');
  assert.equal(info.directPlay, true);
  assert.equal(info.mode, 'direct');
  assert.equal(info.container, 'mov');
  assert.equal(info.videoCodec, 'h264');
  assert.equal(info.audioCodec, 'aac');
  assert.equal(info.width, 160);
  assert.equal(info.height, 120);
  assert.ok(info.duration >= 1.5 && info.duration <= 2.5);
  assert.equal(info.sizeBytes, fs.statSync(directMoviePath).size);
  assert.ok(info.reasons.some((reason) => /Direct play/.test(reason)));
  assert.equal(info.directUrl, `/api/stream/${directMovieId}`);
  assert.ok(info.hlsUrl?.startsWith(`/api/stream/${directMovieId}/hls/master.m3u8`));
  assert.equal(info.transcode.available, true);
  assert.equal(info.transcode.enabled, true);
  assert.equal(info.transcode.limit, 2);
  assert.equal(info.transcode.height, 1080);
  assert.equal(info.transcode.preset, 'veryfast');
  assert.equal(info.transcode.segmentSeconds, 4);
  assert.ok(['auto', 'none', 'nvenc', 'qsv', 'vaapi', 'amf', 'v4l2m2m', 'rkmpp', 'vulkan', 'videotoolbox'].includes(info.transcode.hwaccel.preference));
  assert.ok(Array.isArray(info.transcode.hwaccel.available));
  assert.ok(typeof info.transcode.hardware.encoder === 'string');
  assert.equal(info.audioTracks.length, 1);
  assert.equal(info.audioTracks[0].codec, 'aac');
  assert.equal(info.audioTracks[0].selected, true);
  assert.equal(info.selectedAudio, info.audioTracks[0].index);
  assert.equal(info.subtitles.length, 2);
  assert.ok(info.subtitles.every((subtitle) => subtitle.isExternal && subtitle.format === 'srt'));
  assert.deepEqual(info.subtitles.map((subtitle) => subtitle.label).sort(), ['English', 'English (forced)']);
  assert.equal(info.selectedSubtitle, null);
  assert.equal(info.burn, false);
  assert.equal(info.start, 0);

  const transcodeInfo = await regular.get<StreamInfo>(`/api/stream/${transcodeMovieId}/info`);
  assert.equal(transcodeInfo.status, 200);
  assert.equal(transcodeInfo.json?.directPlay, false);
  assert.equal(transcodeInfo.json?.mode, 'remux');
  assert.equal(transcodeInfo.json?.container, 'matroska');
  assert.ok(transcodeInfo.json!.reasons.some((reason) => /container is not browser-native/.test(reason)));
  assert.ok(transcodeInfo.json!.reasons.some((reason) => /Remux path/.test(reason)));
});

test('playback options are validated, not silently ignored', async () => {
  const forced = await regular.get<StreamInfo>(`/api/stream/${directMovieId}/info?force=1`);
  assert.equal(forced.status, 200);
  assert.equal(forced.json?.directPlay, false);
  assert.equal(forced.json?.mode, 'transcode');
  assert.ok(forced.json!.reasons.some((reason) => /Force-transcode/.test(reason)));

  const info = await regular.get<StreamInfo>(`/api/stream/${directMovieId}/info`);
  const audioIndex = info.json!.audioTracks[0].index;
  const selectedAudio = await regular.get<StreamInfo>(`/api/stream/${directMovieId}/info?audio=${audioIndex}`);
  assert.equal(selectedAudio.status, 200);
  assert.equal(selectedAudio.json?.selectedAudio, audioIndex);
  assert.equal(selectedAudio.json?.audioTracks[0].selected, true);

  const subtitle = info.json!.subtitles.find((entry) => entry.forced === 1)!;
  const burned = await regular.get<StreamInfo>(`/api/stream/${directMovieId}/info?subtitle=${subtitle.id}&burn=1`);
  assert.equal(burned.status, 200);
  assert.equal(burned.json?.selectedSubtitle, subtitle.id);
  assert.equal(burned.json?.burn, true);
  assert.equal(burned.json?.directPlay, false);
  assert.ok(burned.json!.reasons.some((reason) => /burn-in/i.test(reason)));

  const started = await regular.get<StreamInfo>(`/api/stream/${directMovieId}/info?start=30`);
  assert.equal(started.json?.start, 30);

  const cases: string[] = [
    `/api/stream/${directMovieId}/info?audio=999`,
    `/api/stream/${directMovieId}/info?audio=abc`,
    `/api/stream/${directMovieId}/info?audio=-1`,
    `/api/stream/${directMovieId}/info?subtitle=99999`,
    `/api/stream/${directMovieId}/info?subtitle=abc`,
    `/api/stream/${directMovieId}/info?burn=1`,
    `/api/stream/${directMovieId}/info?start=-1`,
    `/api/stream/${directMovieId}/info?start=999999`,
  ];
  for (const pathname of cases) {
    const response = await regular.get(pathname);
    assert.equal(response.status, 400, `${pathname}: ${response.text}`);
    assert.equal((response.json as ErrorBody).error.code, 'bad_request', pathname);
  }
  assert.equal((await regular.get('/api/stream/abc/info')).status, 400);
  assert.equal((await regular.get('/api/stream/0/info')).status, 400);
  assert.equal((await regular.get('/api/stream/99999/info')).status, 404);
});

test('non-playable kinds are rejected with a useful error', async () => {
  const show = await regular.get(`/api/stream/${showId}/info`);
  assert.equal(show.status, 400);
  const showError = show.json as ErrorBody;
  assert.equal(showError.error.code, 'bad_request');
  const showDetails = showError.error.details as { kind?: string } | undefined;
  assert.equal(showDetails?.kind, 'show');

  const photo = await regular.get(`/api/stream/${photoId}`);
  assert.equal(photo.status, 400);
  assert.match((photo.json as ErrorBody).error.message, /not a playable file/);

  const photoInfo = await regular.get(`/api/stream/${photoId}/info`);
  assert.equal(photoInfo.status, 400);
});

test('audio tracks stream directly with browser MIME', async () => {
  const info = await regular.get<StreamInfo>(`/api/stream/${trackId}/info`);
  assert.equal(info.status, 200);
  assert.equal(info.json?.kind, 'track');
  assert.equal(info.json?.directPlay, true);
  assert.equal(info.json?.mode, 'direct');

  const audio = await regular.get(`/api/stream/${trackId}`);
  assert.equal(audio.status, 200);
  assert.equal(audio.contentType, 'audio/mpeg');
  assert.equal(audio.headers.get('accept-ranges'), 'bytes');
  assert.ok(audio.body.length > 1000);
  const ranged = await regular.get(`/api/stream/${trackId}`, { headers: { Range: 'bytes=0-15' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.body.length, 16);
  assert.match(ranged.headers.get('content-range') ?? '', /^bytes 0-15\/\d+$/);
});

test('direct file serving supports full, open, suffix, and invalid ranges plus validators', async () => {
  const file = fs.readFileSync(directMoviePath);
  const full = await regular.get(`/api/stream/${directMovieId}`);
  assert.equal(full.status, 200);
  assert.equal(full.contentType, 'video/mp4');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(full.headers.get('content-length'), String(file.length));
  assert.equal(full.headers.get('content-disposition'), 'inline');
  assert.match(full.headers.get('etag') ?? '', /^W\/"[0-9a-f]+-[0-9a-f]+"$/);
  assert.ok(full.headers.get('last-modified'));
  assert.deepEqual(full.body, file);

  const etag = full.headers.get('etag') ?? '';
  const notModified = await regular.get(`/api/stream/${directMovieId}`, { headers: { 'If-None-Match': etag } });
  assert.equal(notModified.status, 304);
  assert.equal(notModified.body.length, 0);
  const modifiedSince = await regular.get(`/api/stream/${directMovieId}`, { headers: { 'If-Modified-Since': full.headers.get('last-modified') ?? '' } });
  assert.equal(modifiedSince.status, 304);

  const head = await regular.head(`/api/stream/${directMovieId}`);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(file.length));
  assert.equal(head.body.length, 0);

  const first = await regular.get(`/api/stream/${directMovieId}`, { headers: { Range: 'bytes=0-9' } });
  assert.equal(first.status, 206);
  assert.equal(first.headers.get('content-range'), `bytes 0-9/${file.length}`);
  assert.equal(first.headers.get('content-length'), '10');
  assert.deepEqual(first.body, file.subarray(0, 10));

  const open = await regular.get(`/api/stream/${directMovieId}`, { headers: { Range: 'bytes=10-' } });
  assert.equal(open.status, 206);
  assert.equal(open.headers.get('content-range'), `bytes 10-${file.length - 1}/${file.length}`);
  assert.deepEqual(open.body, file.subarray(10));

  const suffix = await regular.get(`/api/stream/${directMovieId}`, { headers: { Range: 'bytes=-16' } });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers.get('content-range'), `bytes ${file.length - 16}-${file.length - 1}/${file.length}`);
  assert.deepEqual(suffix.body, file.subarray(file.length - 16));

  const clampedEnd = await regular.get(`/api/stream/${directMovieId}`, { headers: { Range: `bytes=0-${file.length * 2}` } });
  assert.equal(clampedEnd.status, 206);
  assert.equal(clampedEnd.headers.get('content-range'), `bytes 0-${file.length - 1}/${file.length}`);
  assert.deepEqual(clampedEnd.body, file);

  const multi = await regular.get(`/api/stream/${directMovieId}`, { headers: { Range: 'bytes=0-1,3-4' } });
  assert.equal(multi.status, 200);
  assert.deepEqual(multi.body, file);

  const rangedHead = await regular.head(`/api/stream/${directMovieId}`, { headers: { Range: 'bytes=0-9' } });
  assert.equal(rangedHead.status, 206);
  assert.equal(rangedHead.headers.get('content-length'), '10');
  assert.equal(rangedHead.body.length, 0);

  for (const range of ['bytes=999999999-', 'bytes=abc', 'bytes=5-2', 'bytes=-0', 'items=0-1']) {
    const response = await regular.get(`/api/stream/${directMovieId}`, { headers: { Range: range } });
    if (range === 'items=0-1') {
      // Not a bytes range: browsers get the whole file rather than a confusing failure.
      assert.equal(response.status, 200, range);
      continue;
    }
    assert.equal(response.status, 416, `${range}: ${response.text}`);
    assert.equal(response.headers.get('content-range'), `bytes */${file.length}`);
    const error = JSON.parse(response.text) as ErrorBody;
    assert.equal(error.error.code, 'range_not_satisfiable');
  }
});

test('external SRT subtitles convert to WebVTT and reject bad ids', async () => {
  const list = await regular.get<{ items: SubtitleInfo[]; total?: number }>(`/api/stream/${directMovieId}/subtitles`);
  assert.equal(list.status, 200, list.text);
  assert.ok(list.json, `expected JSON, got ${list.contentType}: ${list.text}`);
  assert.equal(list.json.items.length, 2, list.text);
  const items = list.json!.items;
  assert.ok(items.every((item) => item.isExternal && item.format === 'srt'));
  assert.deepEqual(items.map((item) => item.url), items.map((item) => `/api/stream/${directMovieId}/subtitles/${item.id}.vtt`));
  const plain = items.find((item) => item.forced === 0)!;
  const forced = items.find((item) => item.forced === 1)!;
  assert.equal(plain.language, 'en');
  assert.equal(forced.forced, 1);

  const vtt = await regular.get(plain.url);
  assert.equal(vtt.status, 200);
  assert.match(vtt.contentType, /^text\/vtt; charset=utf-8/);
  assert.match(vtt.text, /^WEBVTT\n\n/);
  assert.match(vtt.text, /00:00:00\.500 --> 00:00:01\.200/);
  assert.match(vtt.text, /First slop line/);
  assert.match(vtt.text, /Second slop line/);

  const cached = await regular.get(plain.url);
  assert.equal(cached.status, 200);
  assert.equal(cached.text, vtt.text);
  const head = await regular.head(plain.url);
  assert.equal(head.status, 200);
  assert.match(head.headers.get('content-type') ?? '', /text\/vtt/);
  assert.ok(Number(head.headers.get('content-length')) > 0);
  assert.equal(head.body.length, 0);

  const forcedVtt = await regular.get(forced.url);
  assert.equal(forcedVtt.status, 200);
  assert.match(forcedVtt.text, /^WEBVTT/);

  const badName = await regular.get(`/api/stream/${directMovieId}/subtitles/not-a-subtitle.vtt`);
  assert.equal(badName.status, 400);
  assert.match((badName.json as ErrorBody).error.message, /subtitles\/<id>\.vtt/);
  const badExtension = await regular.get(`/api/stream/${directMovieId}/subtitles/${plain.id}.txt`);
  assert.equal(badExtension.status, 400);
  const unknown = await regular.get(`/api/stream/${directMovieId}/subtitles/99999.vtt`);
  assert.equal(unknown.status, 404);
  const foreign = await regular.get(`/api/stream/${transcodeMovieId}/subtitles/${plain.id}.vtt`);
  assert.equal(foreign.status, 404);
});

test('HLS master, variant, and segment serving work end to end', async () => {
  const master = await admin.get(`/api/stream/${directMovieId}/hls/master.m3u8?force=1`, { timeoutMs: 60_000 });
  assert.equal(master.status, 200);
  assert.match(master.contentType, /^application\/vnd\.apple\.mpegurl/);
  assert.equal(master.headers.get('cache-control'), 'no-store');
  assert.match(master.text, /^#EXTM3U/);
  const session = master.headers.get('x-transcode-session') ?? '';
  assert.match(session, /^[A-Za-z0-9-]{8,64}$/);
  assert.ok(['starting', 'running'].includes(master.headers.get('x-transcode-state') ?? ''));
  const summary = JSON.parse(master.headers.get('x-transcode-summary') ?? '{}') as {
    id: string;
    mediaId: number;
    state: string;
    height: number;
    preset: string;
    burn: boolean;
  };
  assert.equal(summary.id, session);
  assert.equal(summary.mediaId, directMovieId);
  assert.equal(summary.height, 144);
  assert.equal(summary.burn, false);
  const variantPath = master.text.split('\n').find((line) => line.startsWith('/api/stream/'))!;
  assert.equal(variantPath, `/api/stream/${directMovieId}/hls/${session}/media.m3u8`);
  assert.match(master.text, /#EXT-X-STREAM-INF:BANDWIDTH=\d+,RESOLUTION=\d+x144/);

  const variant = await admin.get(variantPath);
  assert.equal(variant.status, 200);
  assert.match(variant.contentType, /^application\/vnd\.apple\.mpegurl/);
  assert.match(variant.text, /^#EXTM3U/);
  assert.match(variant.text, /#EXT-X-TARGETDURATION:\d+/);
  assert.match(variant.text, /#EXT-X-PLAYLIST-TYPE:EVENT/);
  const segmentName = /(g\d+_seg_\d+\.ts)/.exec(variant.text)?.[1];
  assert.ok(segmentName, `playlist did not list a segment:\n${variant.text}`);

  const segment = await admin.get(`/api/stream/${directMovieId}/hls/${session}/${segmentName}`);
  assert.equal(segment.status, 200);
  assert.equal(segment.contentType, 'video/mp2t');
  assert.match(segment.headers.get('cache-control') ?? '', /private, max-age=3600/);
  assert.ok(segment.body.length > 0);
  assert.equal(segment.body[0], 0x47, 'MPEG-TS segments start with a sync byte');
  const segmentHead = await admin.head(`/api/stream/${directMovieId}/hls/${session}/${segmentName}`);
  assert.equal(segmentHead.status, 200);
  assert.equal(segmentHead.body.length, 0);
  assert.equal(segmentHead.headers.get('content-length'), String(segment.body.length));

  const attacks = [
    `/api/stream/${directMovieId}/hls/${session}/..%2F..%2Fetc%2Fpasswd`,
    `/api/stream/${directMovieId}/hls/${session}/%2e%2e%2f%2e%2e%2fetc%2fpasswd`,
    `/api/stream/${directMovieId}/hls/${session}/evil.sh`,
    `/api/stream/${directMovieId}/hls/${session}/session.json`,
    `/api/stream/${directMovieId}/hls/${session}/media.m3u8.bak`,
  ];
  for (const pathname of attacks) {
    const response = await admin.get(pathname);
    assert.equal(response.status, 404, `${pathname}: ${response.text}`);
    assert.equal((response.json as ErrorBody).error.code, 'not_found', pathname);
  }
  assert.equal((await admin.get(`/api/stream/${directMovieId}/hls/not-a-session/media.m3u8`)).status, 404);
  assert.equal((await admin.get(`/api/stream/${directMovieId}/hls/11111111-1111-4111-8111-111111111111/media.m3u8`)).status, 404);
  assert.equal((await admin.get(`/api/stream/${transcodeMovieId}/hls/${session}/media.m3u8`)).status, 404);

  const foreignDelete = await regular.del(`/api/stream/${directMovieId}/hls/${session}`);
  assert.equal(foreignDelete.status, 403);
  assert.equal((foreignDelete.json as ErrorBody).error.code, 'forbidden');

  const deleted = await admin.del<{ ok: boolean; stopped: boolean }>(`/api/stream/${directMovieId}/hls/${session}`);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.json?.stopped, true);
  const afterDelete = await admin.get(variantPath);
  assert.equal(afterDelete.status, 404);
  assert.equal((afterDelete.json as ErrorBody).error.code, 'session_not_found');
});

test('remux sessions copy video into fragmented MP4 HLS', async () => {
  const master = await admin.get(`/api/stream/${transcodeMovieId}/hls/master.m3u8`, { timeoutMs: 60_000 });
  assert.equal(master.status, 200);
  assert.equal(master.headers.get('x-transcode-mode'), 'remux');
  const session = master.headers.get('x-transcode-session') ?? '';
  assert.match(master.text, /#EXT-X-VERSION:7/);
  const variantPath = master.text.split('\n').find((line) => line.startsWith('/api/stream/'))!;
  const variant = await admin.get(variantPath);
  assert.equal(variant.status, 200);
  assert.match(variant.text, /#EXT-X-MAP:URI="init_\d+\.mp4"/);
  const segmentName = /(g\d+_seg_\d+\.m4s)/.exec(variant.text)?.[1];
  assert.ok(segmentName, `remux playlist did not list an m4s segment:\n${variant.text}`);
  const segment = await admin.get(`/api/stream/${transcodeMovieId}/hls/${session}/${segmentName}`);
  assert.equal(segment.status, 200);
  assert.equal(segment.contentType, 'video/iso.segment');
  assert.ok(segment.body.length > 0);
  const initName = /(init_\d+\.mp4)/.exec(variant.text)?.[1];
  assert.ok(initName, `remux playlist did not reference an init segment:\n${variant.text}`);
  const init = await admin.get(`/api/stream/${transcodeMovieId}/hls/${session}/${initName}`);
  assert.equal(init.status, 200);
  assert.equal(init.contentType, 'video/mp4');
  assert.ok(init.body.length > 0);
  const deleted = await admin.del(`/api/stream/${transcodeMovieId}/hls/${session}`);
  assert.equal(deleted.status, 200);
});

test('seeking reuses the transcode session and restarts at the new offset', async () => {
  const first = await admin.get(`/api/stream/${directMovieId}/hls/master.m3u8?force=1&start=0`, { timeoutMs: 60_000 });
  assert.equal(first.status, 200);
  const session = first.headers.get('x-transcode-session') ?? '';
  const summary = JSON.parse(first.headers.get('x-transcode-summary') ?? '{}') as { start: number; mode: string };
  assert.equal(summary.start, 0);
  assert.equal(summary.mode, 'transcode');

  const second = await admin.get(`/api/stream/${directMovieId}/hls/master.m3u8?force=1&start=1`, { timeoutMs: 60_000 });
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('x-transcode-session'), session, 'seek must not create a second session');
  const seeked = JSON.parse(second.headers.get('x-transcode-summary') ?? '{}') as { start: number; state: string };
  assert.equal(seeked.start, 1);
  assert.ok(['starting', 'running', 'stopped'].includes(seeked.state));
  const variantPath = second.text.split('\n').find((line) => line.startsWith('/api/stream/'))!;
  const variant = await admin.get(variantPath);
  assert.equal(variant.status, 200, `variant ${variantPath} -> ${variant.text}`);
  const segmentName = /(g\d+_seg_\d+\.ts)/.exec(variant.text)?.[1];
  assert.ok(segmentName, `seeked playlist did not list a segment:\n${variant.text}`);
  const segment = await admin.get(`/api/stream/${directMovieId}/hls/${session}/${segmentName}`);
  assert.equal(segment.status, 200, `segment ${segmentName} via ${variantPath}: ${variant.text}`);
  await admin.del(`/api/stream/${directMovieId}/hls/${session}`);
});

test('playback session ids isolate tabs and can be released', async () => {
  const bad = await regular.get(`/api/stream/${directMovieId}/info?psid=x`);
  assert.equal(bad.status, 400);
  const first = await admin.get(`/api/stream/${directMovieId}/hls/master.m3u8?force=1&psid=11111111-1111-4111-8111-111111111111`, { timeoutMs: 60_000 });
  const second = await admin.get(`/api/stream/${directMovieId}/hls/master.m3u8?force=1&psid=22222222-2222-4222-8222-222222222222`, { timeoutMs: 60_000 });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const firstSession = first.headers.get('x-transcode-session') ?? '';
  const secondSession = second.headers.get('x-transcode-session') ?? '';
  assert.notEqual(firstSession, secondSession, 'two tabs must not share one ffmpeg session');
  const released = await admin.post<{ ok: boolean; released: number }>(`/api/stream/${directMovieId}/hls/release`, {
    psid: '11111111-1111-4111-8111-111111111111',
  });
  assert.equal(released.status, 200);
  assert.equal(released.json?.released, 1);
  const firstVariant = first.text.split('\n').find((line) => line.startsWith('/api/stream/'))!;
  assert.equal((await admin.get(firstVariant)).status, 404);
  await admin.del(`/api/stream/${directMovieId}/hls/${secondSession}`);
});

test('hardware acceleration report is admin-only and honest', async () => {
  const denied = await regular.get('/api/hwaccel');
  assert.equal(denied.status, 403);
  const report = await admin.get<{
    encoders: Array<{ kind: string; encoder: string; device: string | null; driver: string | null }>;
    rejected: Array<{ kind: string; reason: string }>;
    softwareAvailable: boolean;
    active: { kind: string; encoder: string; hardware: boolean };
  }>('/api/hwaccel');
  assert.equal(report.status, 200);
  assert.ok(Array.isArray(report.json!.encoders));
  assert.ok(Array.isArray(report.json!.rejected));
  assert.equal(typeof report.json!.softwareAvailable, 'boolean');
  assert.equal(typeof report.json!.active.encoder, 'string');
});

test('playback heartbeat drives resume, finish, history, and stream activity', async () => {
  const fresh = await regular.get<{ progress: unknown; resume: unknown; positionSeconds: number; durationSeconds: number; finished: boolean }>(
    `/api/stream/${transcodeMovieId}/progress`,
  );
  assert.equal(fresh.status, 200);
  assert.equal(fresh.json?.progress, null);
  assert.equal(fresh.json?.resume, null);
  assert.equal(fresh.json?.positionSeconds, 0);
  assert.ok((fresh.json?.durationSeconds ?? 0) >= 1.5);
  assert.equal(fresh.json?.finished, false);

  const first = await regular.post<{
    ok: boolean;
    sessionId: string;
    mode: string;
    started: boolean;
    ended: boolean;
    resume: { positionSeconds: number; durationSeconds: number; finished: boolean; episodeId: number | null; updatedAt: string };
  }>(`/api/stream/${directMovieId}/progress`, { positionSeconds: 0.5, durationSeconds: 2, mode: 'direct' });
  assert.equal(first.status, 200);
  assert.equal(first.json?.ok, true);
  assert.match(first.json?.sessionId ?? '', /^[0-9a-f-]{36}$/);
  assert.equal(first.json?.mode, 'direct');
  assert.equal(first.json?.started, true);
  assert.equal(first.json?.ended, false);
  assert.equal(first.json?.resume.positionSeconds, 0.5);
  assert.equal(first.json?.resume.durationSeconds, 2);
  assert.equal(first.json?.resume.finished, false);
  assert.equal(first.json?.resume.episodeId, null);
  const sessionId = first.json!.sessionId;

  const second = await regular.post<{ started: boolean; sessionId: string }>(`/api/stream/${directMovieId}/progress`, {
    sessionId,
    positionSeconds: 1,
    durationSeconds: 2,
    bytesSent: 2048,
  });
  assert.equal(second.status, 200);
  assert.equal(second.json?.started, false);
  assert.equal(second.json?.sessionId, sessionId);

  const resume = await regular.get<{ resume: { positionSeconds: number; finished: boolean }; positionSeconds: number }>(
    `/api/stream/${directMovieId}/progress`,
  );
  assert.equal(resume.json?.positionSeconds, 1);
  assert.equal(resume.json?.resume.positionSeconds, 1);
  assert.equal(resume.json?.resume.finished, false);

  const finish = await regular.post<{ resume: { finished: boolean; positionSeconds: number } }>(`/api/stream/${directMovieId}/progress`, {
    sessionId,
    positionSeconds: 1.9,
    durationSeconds: 2,
  });
  assert.equal(finish.status, 200);
  assert.equal(finish.json?.resume.finished, true);

  const progress = await regular.get<{ progress: { finished: boolean; positionSeconds: number; playCount: number }; state: { watched: boolean } }>(
    `/api/progress/${directMovieId}`,
  );
  assert.equal(progress.json?.progress.finished, true);
  assert.equal(progress.json?.progress.positionSeconds, 1.9);
  assert.equal(progress.json?.progress.playCount, 1);
  assert.equal(progress.json?.state.watched, true);

  const ended = await regular.post<{ ended: boolean }>(`/api/stream/${directMovieId}/progress`, {
    sessionId,
    positionSeconds: 1.9,
    durationSeconds: 2,
    ended: true,
  });
  assert.equal(ended.status, 200);
  assert.equal(ended.json?.ended, true);
  const activity = await admin.get<{ items: { id: string }[] }>('/api/activity');
  assert.ok(!activity.json!.items.some((item) => item.id === sessionId), 'ended stream must be removed from activity');

  const invalidBodies: Record<string, unknown>[] = [
    { positionSeconds: -1 },
    { positionSeconds: 'fast' },
    { positionSeconds: 1, durationSeconds: -5 },
    { positionSeconds: 1, mode: 'weird' },
    { positionSeconds: 1, bytesSent: -1 },
    { positionSeconds: 1, sessionId: 123 },
  ];
  for (const body of invalidBodies) {
    const response = await regular.post(`/api/stream/${directMovieId}/progress`, body);
    assert.equal(response.status, 400, `${JSON.stringify(body)}: ${response.text}`);
    assert.equal((response.json as ErrorBody).error.code, 'bad_request');
  }
  assert.equal((await regular.post('/api/stream/99999/progress', { positionSeconds: 1 })).status, 404);

  const empty = await regular.post<{ sessionId: string; started: boolean }>(`/api/stream/${directMovieId}/progress`, {});
  assert.equal(empty.status, 200);
  assert.equal(empty.json?.started, true);
  await regular.post(`/api/stream/${directMovieId}/progress`, { sessionId: empty.json!.sessionId, ended: true });
});

test('disabling transcoding turns HLS off but direct play still works', async () => {
  const disabled = await admin.patch('/api/admin/settings', { transcodeEnabled: false });
  assert.equal(disabled.status, 200);

  const info = await regular.get<StreamInfo>(`/api/stream/${directMovieId}/info`);
  assert.equal(info.status, 200);
  assert.equal(info.json?.directPlay, true);
  assert.equal(info.json?.hlsUrl, null);
  assert.equal(info.json?.transcode.enabled, false);
  const forced = await regular.get<StreamInfo>(`/api/stream/${directMovieId}/info?force=1`);
  assert.equal(forced.json?.directPlay, false);
  assert.equal(forced.json?.hlsUrl, null);
  assert.ok(forced.json!.reasons.some((reason) => /Transcoding is disabled/.test(reason)));

  const master = await admin.get(`/api/stream/${directMovieId}/hls/master.m3u8`);
  assert.equal(master.status, 503);
  assert.equal((master.json as ErrorBody).error.code, 'transcode_disabled');

  const enabledAgain = await admin.patch('/api/admin/settings', { transcodeEnabled: true });
  assert.equal(enabledAgain.status, 200);
  const restored = await regular.get<StreamInfo>(`/api/stream/${directMovieId}/info`);
  assert.equal(restored.json?.transcode.enabled, true);
  assert.ok(restored.json?.hlsUrl);
});

