/**
 * Architectural & Security Guardrail Suite (Spec §1, §4, §7).
 *
 * Verifies:
 * 1. `spike/domain-ts` is 100% pure TypeScript with zero UI, DOM, DICOM, or ML imports.
 * 2. No ONNX, ML, or Speckle Tracking dependencies exist in `package.json`.
 * 3. Every synthetic `.dcm` fixture in `spike/fixtures` carries strictly synthetic zero-PHI tags.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DicomParserFileReader } from '../spike/dicom-ts';

const ROOT = path.resolve(import.meta.dirname, '..');

describe('Stage 0 Architectural Purity & Zero-PHI Guardrails', () => {
  it('keeps spike/domain-ts completely free of UI, DOM, DICOM, Worker, or ML dependencies', () => {
    const domainDir = path.join(ROOT, 'spike', 'domain-ts');
    const files = fs.readdirSync(domainDir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThanOrEqual(5);

    const forbiddenPatterns = [
      /from\s+['"]react/,
      /from\s+['"]dicom-parser/,
      /from\s+['"]@cornerstonejs/,
      /from\s+['"]dwv/,
      /from\s+['"]onnx/,
      /dicom-ts/,
      /web-proto/,
      /\bwindow\./,
      /\bdocument\./,
      /\bfetch\s*\(/,
    ];

    for (const file of files) {
      const content = fs.readFileSync(path.join(domainDir, file), 'utf-8');
      for (const pat of forbiddenPatterns) {
        expect(content, `${file} matched forbidden pattern ${pat}`).not.toMatch(pat);
      }
    }
  });

  it('excludes ONNX/ML/STE and vulnerable monolithic packages from runtime dependencies', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as {
      dependencies: Record<string, string>;
    };
    const depNames = Object.keys(pkg.dependencies);
    for (const name of depNames) {
      expect(name).not.toMatch(/onnx|torch|tensorflow|dcmjs|vtk\.js|@cornerstonejs\/core/i);
    }
  });

  it('ensures all 11 committed DICOM fixtures contain strictly synthetic zero-PHI tags', () => {
    const fixturesDir = path.join(ROOT, 'spike', 'fixtures');
    const dcmFiles = fs.readdirSync(fixturesDir).filter((f) => f.endsWith('.dcm'));
    expect(dcmFiles.length).toBe(11);

    const reader = new DicomParserFileReader();
    for (const file of dcmFiles) {
      const bytes = new Uint8Array(fs.readFileSync(path.join(fixturesDir, file)));
      const meta = reader.readMetadata(bytes, file, file);
      expect(meta.phi.patientName).toBe('SYNTHETIC^ECHO^PHANTOM');
      expect(meta.phi.patientId).toMatch(/^SYN-/);
      expect(meta.phi.patientBirthDate).toBe('19800101');
      expect(meta.phi.institutionName).toBe('SYNTHETIC_ECHO_LAB');
    }
  });
});
