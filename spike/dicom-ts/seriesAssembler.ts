/**
 * `SeriesAssembler` implementation: groups `ParsedDicomInstance[]` into `StudyRef -> SeriesRef -> ImageFrameRef`
 * strictly by DICOM UIDs (`StudyInstanceUID`, `SeriesInstanceUID`, `SOPInstanceUID`).
 */

import type { ImageFrameRef, ParsedDicomInstance, SeriesAssembler, SeriesRef, StudyRef } from './ports';

export class DefaultSeriesAssembler implements SeriesAssembler {
  public assembleStudies(
    instances: readonly ParsedDicomInstance[],
    source: 'local' | 'dicomweb' = 'local',
  ): StudyRef[] {
    const byStudy = new Map<string, ParsedDicomInstance[]>();
    for (const inst of instances) {
      const list = byStudy.get(inst.studyInstanceUid);
      if (list) list.push(inst);
      else byStudy.set(inst.studyInstanceUid, [inst]);
    }

    const studies: StudyRef[] = [];
    for (const [studyInstanceUid, studyInstances] of byStudy) {
      const bySeries = new Map<string, ParsedDicomInstance[]>();
      for (const inst of studyInstances) {
        const list = bySeries.get(inst.seriesInstanceUid);
        if (list) list.push(inst);
        else bySeries.set(inst.seriesInstanceUid, [inst]);
      }

      const seriesList: SeriesRef[] = [];
      for (const [seriesInstanceUid, seriesInstances] of bySeries) {
        const sorted = [...seriesInstances].sort(
          (a, b) => a.instanceNumber - b.instanceNumber || a.fileName.localeCompare(b.fileName),
        );
        const first = sorted[0]!;
        const frames: ImageFrameRef[] = [];
        for (const inst of sorted) {
          for (let f = 0; f < inst.numberOfFrames; f++) {
            frames.push({
              sopInstanceUid: inst.sopInstanceUid,
              frameIndex: f,
              rows: inst.rows,
              columns: inst.columns,
              pixelSpacingMm: inst.pixelSpacing?.spacingMm ?? null,
              pixelSpacingSource: inst.pixelSpacing?.source ?? null,
              timestampMs: inst.frameTimeMs !== null ? f * inst.frameTimeMs : null,
            });
          }
        }

        seriesList.push({
          seriesInstanceUid,
          modality: first.modality,
          description: first.seriesDescription,
          seriesNumber: first.seriesNumber,
          rows: first.rows,
          columns: first.columns,
          totalFrames: frames.length,
          transferSyntaxUid: first.transferSyntax.uid,
          transferSyntaxName: first.transferSyntax.name,
          supportedInBrowser: sorted.every((i) => i.transferSyntax.supportedInBrowser),
          isLossless: sorted.every((i) => i.transferSyntax.lossless),
          clipMode: first.clipMode,
          instances: sorted,
          frames,
        });
      }

      seriesList.sort((a, b) => a.seriesNumber - b.seriesNumber || a.description.localeCompare(b.description));
      const lead = studyInstances[0]!;
      const equipmentLabel = [lead.manufacturer, lead.modelName].filter(Boolean).join(' ') || 'Unknown Scanner';
      studies.push({
        studyInstanceUid,
        studyDate: lead.studyDate,
        description: lead.studyDescription,
        source,
        equipmentLabel,
        series: seriesList,
      });
    }

    return studies;
  }
}
