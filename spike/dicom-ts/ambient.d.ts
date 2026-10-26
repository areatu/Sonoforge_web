declare module 'dicom-parser' {
  export interface Element {
    tag: string;
    vr?: string;
    length: number;
    dataOffset: number;
    encapsulatedPixelData?: boolean;
    basicOffsetTable?: number[];
    fragments?: Array<{ offset: number; position: number; length: number }>;
    items?: Array<{ tag: string; length: number; dataOffset: number; dataSet?: DataSet }>;
  }

  export interface DataSet {
    byteArray: Uint8Array;
    elements: Record<string, Element>;
    string(tag: string, index?: number): string | undefined;
    uint16(tag: string, index?: number): number | undefined;
    int16(tag: string, index?: number): number | undefined;
    uint32(tag: string, index?: number): number | undefined;
    int32(tag: string, index?: number): number | undefined;
    float(tag: string, index?: number): number | undefined;
    double(tag: string, index?: number): number | undefined;
    floatString(tag: string, index?: number): number | undefined;
    intString(tag: string, index?: number): number | undefined;
    numStringValues(tag: string): number | undefined;
  }

  export function parseDicom(
    byteArray: Uint8Array,
    options?: { untilTag?: string; vrCallback?: (tag: string) => string },
  ): DataSet;

  export function readEncapsulatedImageFrame(
    dataSet: DataSet,
    pixelDataElement: Element,
    frameIndex: number,
    basicOffsetTable?: number[],
    fragments?: Array<{ offset: number; position: number; length: number }>,
  ): Uint8Array;

  export function readEncapsulatedPixelDataFromFragments(
    dataSet: DataSet,
    pixelDataElement: Element,
    startFragmentIndex: number,
    numFragments?: number,
    fragments?: Array<{ offset: number; position: number; length: number }>,
  ): Uint8Array;

  export function createJPEGBasicOffsetTable(
    dataSet: DataSet,
    pixelDataElement: Element,
    fragments?: Array<{ offset: number; position: number; length: number }>,
  ): number[];
}

declare module '@cornerstonejs/codec-openjpeg/decodewasmjs' {
  export interface J2KFrameInfo {
    width: number;
    height: number;
    bitsPerSample: number;
    componentCount: number;
    isSigned: boolean;
  }
  export interface J2KDecoder {
    getEncodedBuffer(length: number): Uint8Array;
    decode(): void;
    getFrameInfo(): J2KFrameInfo;
    getDecodedBuffer(): Uint8Array;
    delete?: () => void;
  }
  export interface OpenJpegInstance {
    J2KDecoder: new () => J2KDecoder;
  }
  export default function openJpegFactory(options?: {
    locateFile?: (filename: string, prefix?: string) => string;
  }): Promise<OpenJpegInstance>;
}

declare module '@cornerstonejs/codec-libjpeg-turbo-8bit/decodewasmjs' {
  export interface JpegTurboFrameInfo {
    width: number;
    height: number;
    bitsPerSample: number;
    componentCount: number;
  }
  export interface JPEGDecoder {
    getEncodedBuffer(length: number): Uint8Array;
    decode(): void;
    getFrameInfo(): JpegTurboFrameInfo;
    getDecodedBuffer(): Uint8Array;
    delete?: () => void;
  }
  export interface LibJpegTurboInstance {
    JPEGDecoder: new () => JPEGDecoder;
  }
  export default function libjpegTurboFactory(options?: {
    locateFile?: (filename: string, prefix?: string) => string;
  }): Promise<LibJpegTurboInstance>;
}

declare module '@cornerstonejs/codec-charls/decodewasmjs' {
  export interface CharlsFrameInfo {
    width: number;
    height: number;
    bitsPerSample: number;
    componentCount: number;
  }
  export interface JpegLSDecoder {
    getEncodedBuffer(length: number): Uint8Array;
    decode(): void;
    getFrameInfo(): CharlsFrameInfo;
    getDecodedBuffer(): Uint8Array;
    delete?: () => void;
  }
  export interface CharlsInstance {
    JpegLSDecoder: new () => JpegLSDecoder;
    getExceptionMessage?: (ptr: number) => string;
  }
  export default function charlsFactory(options?: {
    locateFile?: (filename: string, prefix?: string) => string;
  }): Promise<CharlsInstance>;
}

declare module '@cornerstonejs/codec-openjph' {
  export interface HTJ2KDecoder {
    getEncodedBuffer(length: number): Uint8Array;
    decode(): void;
    getFrameInfo(): {
      width: number;
      height: number;
      bitsPerSample: number;
      componentCount: number;
      isSigned: boolean;
    };
    getDecodedBuffer(): Uint8Array;
  }
  export interface OpenJphInstance {
    HTJ2KDecoder: new () => HTJ2KDecoder;
  }
  export default function openjphFactory(options?: {
    locateFile?: (filename: string, prefix?: string) => string;
  }): Promise<OpenJphInstance>;
}
