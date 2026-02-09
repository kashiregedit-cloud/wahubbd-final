import { IMediaEngineProcessor } from '@waha/core/media/IMediaEngineProcessor';
import { WAMedia } from '@waha/structures/media.dto';
import { IMediaConverter } from './IConverter';

/**
 * General interface for MediaManager - one that handles the logic
 * and manipulates MediaStorage and MediaEngineProcessor
 */
interface IMediaManager {
  processMedia<Message>(
    processor: IMediaEngineProcessor<Message>,
    message: Message,
    session: string,
    mediaConverter?: IMediaConverter,
  ): Promise<WAMedia | null>;
  close(): void;
}

export { IMediaManager };
