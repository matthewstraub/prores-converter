import fs from "fs";

/**
 * MOV/QuickTime Atom Patcher for AJA DDR Compatibility
 *
 * After FFmpeg encodes a ProRes file, this module patches the .mov binary
 * to match the atom structure that AJA DDR hardware expects:
 *
 * 1. Handler names: Replace FFmpeg's generic "Core Media Video/Audio" with
 *    AJA-specific handler names in hdlr atoms
 * 2. Container minor_version: Change from FFmpeg's 512 to Apple/AJA's 537199360
 *
 * Strategy: Parse the MOV into an atom tree, modify specific atoms, then
 * serialize the tree back to binary. This avoids offset/size corruption
 * that occurs with in-place patching when atom sizes change.
 */

// Handler subtypes
const VIDE = "vide";
const SOUN = "soun";
const TMCD_TYPE = "tmcd";

// AJA handler names
const AJA_VIDEO_HANDLER = "AJA Video Media Handler";
const AJA_SOUND_HANDLER = "AJA Sound Media Handler";
const AJA_TMCD_HANDLER = "AJA Time Code Handler";

// Apple/AJA container minor version
const AJA_MINOR_VERSION = 537199360; // 0x20070800

// Container atom types whose children are also atoms
const CONTAINER_TYPES = new Set([
  "moov", "trak", "mdia", "minf", "stbl", "dinf", "edts", "udta",
]);

// ─── Atom Tree ───────────────────────────────────────────────────────

interface Atom {
  type: string;
  /** For container atoms: child atoms */
  children?: Atom[];
  /** For leaf atoms: raw payload (everything after the 8-byte header) */
  payload?: Buffer;
}

/**
 * Parse a region of a buffer into an array of Atom nodes.
 */
function parseAtoms(buf: Buffer, start: number, end: number): Atom[] {
  const atoms: Atom[] = [];
  let pos = start;

  while (pos + 8 <= end) {
    const size = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString("ascii");

    if (size < 8 || pos + size > end) break;

    const payloadStart = pos + 8;
    const payloadEnd = pos + size;

    if (CONTAINER_TYPES.has(type)) {
      // Recursively parse children
      atoms.push({
        type,
        children: parseAtoms(buf, payloadStart, payloadEnd),
      });
    } else {
      // Leaf atom — store raw payload
      atoms.push({
        type,
        payload: Buffer.from(buf.subarray(payloadStart, payloadEnd)),
      });
    }

    pos += size;
  }

  return atoms;
}

/**
 * Serialize an array of Atom nodes back to a Buffer.
 */
function serializeAtoms(atoms: Atom[]): Buffer {
  const parts: Buffer[] = [];

  for (const atom of atoms) {
    if (atom.children) {
      // Container atom
      const childBuf = serializeAtoms(atom.children);
      const header = Buffer.alloc(8);
      header.writeUInt32BE(8 + childBuf.length, 0);
      header.write(atom.type, 4, 4, "ascii");
      parts.push(header, childBuf);
    } else if (atom.payload) {
      // Leaf atom
      const header = Buffer.alloc(8);
      header.writeUInt32BE(8 + atom.payload.length, 0);
      header.write(atom.type, 4, 4, "ascii");
      parts.push(header, atom.payload);
    }
  }

  return Buffer.concat(parts);
}

// ─── hdlr Atom Helpers ───────────────────────────────────────────────

/**
 * Get the handler subtype from an hdlr atom payload.
 * Payload layout: [4 version+flags][4 comp_type][4 subtype][4 mfr][4 flags][4 mask][name...]
 * Subtype is at payload offset 8.
 */
function getHdlrSubtype(payload: Buffer): string {
  return payload.subarray(8, 12).toString("ascii");
}

/**
 * Build a new hdlr payload with a custom handler name.
 * Keeps the first 24 bytes (version+flags, comp_type, subtype, manufacturer,
 * comp_flags, comp_flags_mask) and replaces the pascal-string name.
 */
function buildHdlrPayload(originalPayload: Buffer, newName: string): Buffer {
  const fixedSize = 24; // 4+4+4+4+4+4
  const fixed = Buffer.from(originalPayload.subarray(0, fixedSize));

  const nameBytes = Buffer.from(newName, "ascii");
  const pascal = Buffer.alloc(1 + nameBytes.length);
  pascal[0] = nameBytes.length;
  nameBytes.copy(pascal, 1);

  return Buffer.concat([fixed, pascal]);
}

/**
 * Determine the AJA handler name for a given subtype.
 */
function getAjaHandlerName(subtype: string): string | null {
  if (subtype === VIDE) return AJA_VIDEO_HANDLER;
  if (subtype === SOUN) return AJA_SOUND_HANDLER;
  if (subtype === TMCD_TYPE) return AJA_TMCD_HANDLER;
  return null;
}

// ─── Tree Mutation ───────────────────────────────────────────────────

/**
 * Walk the atom tree and patch all hdlr atoms with AJA handler names.
 */
function patchHdlrAtoms(atoms: Atom[]): void {
  for (const atom of atoms) {
    if (atom.type === "hdlr" && atom.payload) {
      const subtype = getHdlrSubtype(atom.payload);
      const newName = getAjaHandlerName(subtype);
      if (newName) {
        atom.payload = buildHdlrPayload(atom.payload, newName);
      }
    }
    if (atom.children) {
      patchHdlrAtoms(atom.children);
    }
  }
}

/**
 * Patch the ftyp atom's minor_version field.
 * ftyp payload: [4 major_brand][4 minor_version][...compatible_brands]
 */
function patchFtyp(atoms: Atom[]): void {
  for (const atom of atoms) {
    if (atom.type === "ftyp" && atom.payload && atom.payload.length >= 8) {
      atom.payload.writeUInt32BE(AJA_MINOR_VERSION, 4);
    }
  }
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Patch the .mov file for AJA DDR compatibility.
 *
 * This function:
 * 1. Parses the MOV file into an atom tree
 * 2. Patches ftyp minor_version to 537199360
 * 3. Replaces all hdlr handler names with AJA-specific names
 * 4. Serializes the tree back to binary (sizes are recalculated automatically)
 *
 * @param filePath Path to the .mov file to patch (modified in-place)
 */
export async function patchMovForAja(filePath: string): Promise<void> {
  const buf = Buffer.from(fs.readFileSync(filePath));

  // Parse the entire file into an atom tree
  const atoms = parseAtoms(buf, 0, buf.length);

  // Patch ftyp minor_version
  patchFtyp(atoms);

  // Patch all hdlr atoms with AJA handler names
  patchHdlrAtoms(atoms);

  // Serialize back to binary — sizes are calculated fresh during serialization
  const patched = serializeAtoms(atoms);

  // Write the patched file
  fs.writeFileSync(filePath, new Uint8Array(patched.buffer, patched.byteOffset, patched.byteLength));
}

/**
 * Check if prores_videotoolbox encoder is available.
 * This encoder is only available on macOS with Apple Silicon or Intel + VideoToolbox.
 */
export function checkVideoToolboxAvailable(ffmpegPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const { execFile } = require("child_process") as typeof import("child_process");
    execFile(
      ffmpegPath,
      ["-hide_banner", "-encoders"],
      { maxBuffer: 5 * 1024 * 1024 },
      (error: any, stdout: string) => {
        if (error) {
          resolve(false);
          return;
        }
        resolve(stdout.includes("prores_videotoolbox"));
      }
    );
  });
}
