/** Platforms that ugoke downloads the Temporal CLI for, as `<platform>-<arch>` of Node.js. */
export const temporalCliPlatforms = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
] as const;

/** A platform that ugoke downloads the Temporal CLI for. */
export type TemporalCliPlatform = (typeof temporalCliPlatforms)[number];

/** A release archive of the Temporal CLI and its checksum. */
export interface TemporalCliAsset {
  /** File name of the archive in the GitHub release. */
  file: string;
  /** SHA-256 of the archive, in hexadecimal. */
  sha256: string;
}

/** The pinned release of the Temporal CLI. */
export interface TemporalCliManifest {
  version: string;
  assets: Readonly<Record<TemporalCliPlatform, TemporalCliAsset>>;
}
