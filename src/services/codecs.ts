import type { MediaRow } from '../types.ts';

/** Codec aliases from ffprobe/containers, collapsed to the names the playback policy uses. */
export function normalizeCodec(codec: string | null | undefined): string {
  const value = (codec || '').toLowerCase().replace(/[\s.]/g, '');
  if (!value) return '';
  if (value === 'avc1' || value === 'avc3' || value === 'x264' || value === 'h.264') return 'h264';
  if (value === 'hev1' || value === 'hvc1' || value === 'h265' || value === 'h.265' || value === 'x265') return 'hevc';
  if (value === 'vp09' || value === 'vp9') return 'vp9';
  if (value === 'vp08' || value === 'vp8') return 'vp8';
  if (value === 'av01' || value === 'av1') return 'av1';
  if (value === 'mp4v' || value === 'mp4v-es' || value === 'mpeg4') return 'mpeg4';
  if (value === 'mp2v' || value === 'mpeg2video') return 'mpeg2';
  if (value === 'mpeg1video') return 'mpeg1';
  if (value === 'mp4a' || value === 'mp4a.40.2') return 'aac';
  if (value === 'mp3' || value === 'mp3float') return 'mp3';
  if (value === 'vorbis') return 'vorbis';
  if (value === 'opus') return 'opus';
  if (value === 'flac') return 'flac';
  if (value === 'ac3' || value === 'eac3') return 'ac3';
  if (value === 'dts') return 'dts';
  if (value === 'truehd') return 'truehd';
  return value;
}

/**
 * Codecs safe to copy into fragmented MP4 HLS. Deliberately narrower than every browser on
 * earth: hevc is hardware- and browser-dependent, so it still gets a real transcode.
 */
export const REMUX_VIDEO: Record<string, true> = { h264: true, av1: true, vp9: true };
export const REMUX_AUDIO: Record<string, true> = { aac: true, mp3: true, opus: true };

/**
 * Remux means "no video re-encode". Audio may still be re-encoded when the source track is
 * not copy-safe, which is exactly the cheap path Jellyfin uses for MKV with AC3/DTS audio.
 */
export function remuxEligible(row: MediaRow, options: { burn: boolean; forceTranscode: boolean }): boolean {
  if (row.kind === 'track') return false;
  if (options.burn || options.forceTranscode) return false;
  return Boolean(REMUX_VIDEO[normalizeCodec(row.video_codec)]);
}
