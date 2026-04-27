import { describe, expect, it } from "vitest";
import { patchMovForAja, checkVideoToolboxAvailable } from "./movPatcher";
import fs from "fs";
import path from "path";
import os from "os";

/**
 * Build a minimal valid .mov file structure for testing the atom patcher.
 *
 * The structure is:
 *   ftyp (major_brand=qt, minor_version=512)
 *   moov
 *     trak (video)
 *       mdia
 *         hdlr (vide, "Core Media Video")
 *     trak (audio 1)
 *       mdia
 *         hdlr (soun, "Core Media Audio")
 *     trak (audio 2)
 *       mdia
 *         hdlr (soun, "Core Media Audio")
 *     trak (tmcd)
 *       mdia
 *         hdlr (tmcd, "Core Media Video")
 */
function buildTestMov(): Buffer {
  const parts: Buffer[] = [];

  // --- ftyp atom ---
  // ftyp: [size][type][major_brand][minor_version][compatible_brands...]
  const ftyp = Buffer.alloc(20);
  ftyp.writeUInt32BE(20, 0);           // size
  ftyp.write("ftyp", 4);              // type
  ftyp.write("qt  ", 8);              // major_brand
  ftyp.writeUInt32BE(512, 12);        // minor_version (FFmpeg default)
  ftyp.write("qt  ", 16);             // compatible_brand
  parts.push(ftyp);

  // --- Build hdlr atoms ---
  function buildHdlr(subtype: string, handlerName: string): Buffer {
    // hdlr: [size][type][version+flags][comp_type][subtype][manufacturer][flags][flags_mask][pascal_string]
    const nameBytes = Buffer.from(handlerName, "ascii");
    const totalSize = 32 + 1 + nameBytes.length; // 32 fixed + 1 length byte + name
    const hdlr = Buffer.alloc(totalSize);
    hdlr.writeUInt32BE(totalSize, 0);  // size
    hdlr.write("hdlr", 4);            // type
    // version + flags = 0 (4 bytes at offset 8)
    hdlr.write("mhlr", 12);           // component_type
    hdlr.write(subtype, 16);          // component_subtype
    // manufacturer, flags, flags_mask = 0 (12 bytes at offset 20)
    hdlr[32] = nameBytes.length;       // pascal string length byte
    nameBytes.copy(hdlr, 33);          // pascal string data
    return hdlr;
  }

  function wrapInAtom(type: string, ...children: Buffer[]): Buffer {
    let childrenSize = 0;
    for (const c of children) childrenSize += c.length;
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + childrenSize, 0);
    header.write(type, 4);
    return Buffer.concat([header, ...children]);
  }

  // Build tracks
  const videoHdlr = buildHdlr("vide", "Core Media Video");
  const videoMdia = wrapInAtom("mdia", videoHdlr);
  const videoTrak = wrapInAtom("trak", videoMdia);

  const audio1Hdlr = buildHdlr("soun", "Core Media Audio");
  const audio1Mdia = wrapInAtom("mdia", audio1Hdlr);
  const audio1Trak = wrapInAtom("trak", audio1Mdia);

  const audio2Hdlr = buildHdlr("soun", "Core Media Audio");
  const audio2Mdia = wrapInAtom("mdia", audio2Hdlr);
  const audio2Trak = wrapInAtom("trak", audio2Mdia);

  const tmcdHdlr = buildHdlr("tmcd", "Core Media Video");
  const tmcdMdia = wrapInAtom("mdia", tmcdHdlr);
  const tmcdTrak = wrapInAtom("trak", tmcdMdia);

  // moov containing all tracks
  const moov = wrapInAtom("moov", videoTrak, audio1Trak, audio2Trak, tmcdTrak);
  parts.push(moov);

  return Buffer.concat(parts);
}

/**
 * Find a substring in a buffer and return its offset, or -1 if not found.
 */
function findInBuffer(buf: Buffer, search: string): number {
  const searchBuf = Buffer.from(search, "ascii");
  for (let i = 0; i <= buf.length - searchBuf.length; i++) {
    if (buf.subarray(i, i + searchBuf.length).equals(searchBuf)) {
      return i;
    }
  }
  return -1;
}

describe("movPatcher", () => {
  const testDir = path.join(os.tmpdir(), "movpatcher-test");

  function getTestFilePath(name: string): string {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    return path.join(testDir, name);
  }

  describe("patchMovForAja", () => {
    it("patches ftyp minor_version to 537199360", async () => {
      const testMov = buildTestMov();
      const filePath = getTestFilePath("test-ftyp.mov");
      fs.writeFileSync(filePath, testMov);

      await patchMovForAja(filePath);

      const patched = fs.readFileSync(filePath);
      // minor_version is at ftyp offset + 12
      const minorVersion = patched.readUInt32BE(12);
      expect(minorVersion).toBe(537199360);

      fs.unlinkSync(filePath);
    });

    it("replaces video handler name with AJA Video Media Handler", async () => {
      const testMov = buildTestMov();
      const filePath = getTestFilePath("test-video-hdlr.mov");
      fs.writeFileSync(filePath, testMov);

      await patchMovForAja(filePath);

      const patched = fs.readFileSync(filePath);
      // The old name should be gone
      expect(findInBuffer(patched, "Core Media Video")).toBe(-1);
      // The new name should be present
      expect(findInBuffer(patched, "AJA Video Media Handler")).toBeGreaterThan(0);

      fs.unlinkSync(filePath);
    });

    it("replaces audio handler names with AJA Sound Media Handler", async () => {
      const testMov = buildTestMov();
      const filePath = getTestFilePath("test-audio-hdlr.mov");
      fs.writeFileSync(filePath, testMov);

      await patchMovForAja(filePath);

      const patched = fs.readFileSync(filePath);
      // No "Core Media Audio" should remain
      expect(findInBuffer(patched, "Core Media Audio")).toBe(-1);
      // "AJA Sound Media Handler" should appear (at least twice for 2 audio tracks)
      const first = findInBuffer(patched, "AJA Sound Media Handler");
      expect(first).toBeGreaterThan(0);
      const second = findInBuffer(
        patched.subarray(first + 1),
        "AJA Sound Media Handler"
      );
      expect(second).toBeGreaterThanOrEqual(0);

      fs.unlinkSync(filePath);
    });

    it("replaces tmcd handler name with AJA Time Code Handler", async () => {
      const testMov = buildTestMov();
      const filePath = getTestFilePath("test-tmcd-hdlr.mov");
      fs.writeFileSync(filePath, testMov);

      await patchMovForAja(filePath);

      const patched = fs.readFileSync(filePath);
      expect(findInBuffer(patched, "AJA Time Code Handler")).toBeGreaterThan(0);

      fs.unlinkSync(filePath);
    });

    it("maintains valid atom structure after patching", async () => {
      const testMov = buildTestMov();
      const filePath = getTestFilePath("test-structure.mov");
      fs.writeFileSync(filePath, testMov);

      await patchMovForAja(filePath);

      const patched = fs.readFileSync(filePath);

      // Verify ftyp atom is valid
      const ftypSize = patched.readUInt32BE(0);
      expect(patched.subarray(4, 8).toString("ascii")).toBe("ftyp");
      expect(ftypSize).toBe(20);

      // Verify moov atom starts after ftyp
      const moovOffset = ftypSize;
      expect(patched.subarray(moovOffset + 4, moovOffset + 8).toString("ascii")).toBe("moov");

      // Verify moov size covers the rest of the file
      const moovSize = patched.readUInt32BE(moovOffset);
      expect(moovOffset + moovSize).toBe(patched.length);

      fs.unlinkSync(filePath);
    });
  });

  describe("checkVideoToolboxAvailable", () => {
    it("returns a boolean", async () => {
      const result = await checkVideoToolboxAvailable("ffmpeg");
      expect(typeof result).toBe("boolean");
    });

    it("returns false for a non-existent ffmpeg path", async () => {
      const result = await checkVideoToolboxAvailable("/nonexistent/ffmpeg");
      expect(result).toBe(false);
    });
  });
});
