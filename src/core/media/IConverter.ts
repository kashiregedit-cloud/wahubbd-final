import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';

export interface IMediaConverter {
  voice(content: Buffer): Promise<Buffer>;
  video(content: Buffer): Promise<Buffer>;
}

export class CoreMediaConverter implements IMediaConverter {
  constructor() {
    if (ffmpegPath) {
      ffmpeg.setFfmpegPath(ffmpegPath);
    }
  }

  async video(content: Buffer): Promise<Buffer> {
    return content;
  }

  async voice(content: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const tempDir = os.tmpdir();
      const inputPath = path.join(tempDir, `waha_input_${Date.now()}.ogg`);
      const outputPath = path.join(tempDir, `waha_output_${Date.now()}.mp3`);

      fs.writeFileSync(inputPath, content);

      ffmpeg(inputPath)
        .toFormat('mp3')
        .on('error', (err) => {
          this.cleanup(inputPath, outputPath);
          // If conversion fails, return original content (fallback)
          // or reject? User asked for MP3, so let's log and return original if fail?
          // But usually we want to know if it failed.
          // For now, let's reject so we can see the error.
          reject(err);
        })
        .on('end', () => {
          try {
            const mp3Content = fs.readFileSync(outputPath);
            this.cleanup(inputPath, outputPath);
            resolve(mp3Content);
          } catch (err) {
            reject(err);
          }
        })
        .save(outputPath);
    });
  }

  private cleanup(...paths: string[]) {
    paths.forEach((p) => {
      if (fs.existsSync(p)) {
        try {
          fs.unlinkSync(p);
        } catch (e) {
          // ignore
        }
      }
    });
  }
}
