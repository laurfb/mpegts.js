/*
 * MSE Controller for mpegts.js
 * Modified to handle enhanced MEDIA_INFO events with color metadata
 */

import {
    BaseController
} from './base-controller.js';
import {
    Events,
    ErrorTypes,
    ErrorDetails
} from '../utils/events.js';
import {
    Log
} from '../utils/logger.js';
import {
    Transmuxer
} from './transmuxer.js';

class MSEController extends BaseController {
    constructor(mediaElement, config) {
        super();

        this.TAG = 'MSEController';
        this._config = config || {};
        this._mediaElement = mediaElement;

        this._mediaSource = null;
        this._sourceBuffer = null;
        this._mimeType = null;
        this._transmuxer = null;
        this._isBufferFull = false;
        this._hasPendingData = false;
        this._pendingData = [];
        this._pendingDataSize = 0;
        this._pendingAppendLength = 0;

        this._mediaInfo = null;
        this._stats = {};
        this._audioCodec = '';
        this._videoCodec = '';

        this._onSourceOpen = this._onSourceOpen.bind(this);
        this._onSourceEnded = this._onSourceEnded.bind(this);
        this._onSourceClose = this._onSourceClose.bind(this);
        this._onUpdateEnd = this._onUpdateEnd.bind(this);
        this._onBufferFull = this._onBufferFull.bind(this);

        this._mediaSource = new window.MediaSource();
        this._mediaSource.addEventListener('sourceopen', this._onSourceOpen);
        this._mediaSource.addEventListener('sourceended', this._onSourceEnded);
        this._mediaSource.addEventListener('sourceclose', this._onSourceClose);

        mediaElement.src = window.URL.createObjectURL(this._mediaSource);
    }

    destroy() {
        if (this._transmuxer) {
            this._transmuxer.destroy();
            this._transmuxer = null;
        }

        if (this._sourceBuffer) {
            this._sourceBuffer.removeEventListener('updateend', this._onUpdateEnd);
            this._sourceBuffer = null;
        }

        if (this._mediaSource) {
            this._mediaSource.removeEventListener('sourceopen', this._onSourceOpen);
            this._mediaSource.removeEventListener('sourceended', this._onSourceEnded);
            this._mediaSource.removeEventListener('sourceclose', this._onSourceClose);

            if (this._mediaSource.readyState === 'open') {
                try {
                    this._mediaSource.endOfStream();
                } catch (e) {
                    Log.e(this.TAG, 'Error ending MediaSource stream:', e);
                }
            }

            this._mediaSource = null;
        }

        if (this._mediaElement) {
            this._mediaElement.removeAttribute('src');
            this._mediaElement.load();
            this._mediaElement = null;
        }

        this._pendingData = [];
        this._pendingDataSize = 0;
    }

    _onSourceOpen() {
        Log.v(this.TAG, 'MediaSource sourceopen event');

        try {
            this._mimeType = this._getMimeType();
            this._sourceBuffer = this._mediaSource.addSourceBuffer(this._mimeType);
            this._sourceBuffer.addEventListener('updateend', this._onUpdateEnd);
            this._sourceBuffer.mode = 'segments';

            this._transmuxer = new Transmuxer(this._config);
            this._transmuxer.onInitSegment = this._onInitSegment.bind(this);
            this._transmuxer.onMediaSegment = this._onMediaSegment.bind(this);
            this._transmuxer.onMediaInfo = this._onMediaInfo.bind(this);
            this._transmuxer.onMetadata = this._onMetadata.bind(this);
            this._transmuxer.onScriptData = this._onScriptData.bind(this);
            this._transmuxer.onTimedID3 = this._onTimedID3.bind(this);
            this._transmuxer.onError = this._onError.bind(this);

            this.dispatchEvent(Events.MSE_SOURCE_OPEN);
        } catch (e) {
            Log.e(this.TAG, 'Error creating SourceBuffer:', e);
            this.dispatchEvent(Events.ERROR, {
                type: ErrorTypes.MEDIA_ERROR,
                details: ErrorDetails.MSE_SOURCE_BUFFER_CONSTRUCTOR_EXCEPTION,
                err: e
            });
        }
    }

    _onSourceEnded() {
        Log.v(this.TAG, 'MediaSource sourceended event');
    }

    _onSourceClose() {
        Log.v(this.TAG, 'MediaSource sourceclose event');
    }

    _onUpdateEnd() {
        Log.v(this.TAG, 'SourceBuffer updateend event');

        this._isBufferFull = false;
        this._pendingAppendLength = 0;

        if (this._hasPendingData) {
            this._hasPendingData = false;
            this._appendPendingData();
        }

        this.dispatchEvent(Events.MSE_UPDATE_END);
    }

    _onBufferFull() {
        Log.w(this.TAG, 'SourceBuffer buffer full');
        this._isBufferFull = true;
        this.dispatchEvent(Events.BUFFER_FULL);
    }

    _getMimeType() {
        let mimeType = 'video/mp4; codecs="';

        if (this._audioCodec && this._videoCodec) {
            mimeType += `${this._videoCodec}, ${this._audioCodec}`;
        } else if (this._videoCodec) {
            mimeType += this._videoCodec;
        } else if (this._audioCodec) {
            mimeType += this._audioCodec;
        } else {
            mimeType += 'avc1.42e01e, mp4a.40.2';
        }

        mimeType += '"';
        return mimeType;
    }

    _onInitSegment(initSegment, track) {
        // Handle initialization segment if needed
    }

    _onMediaSegment(data, track, timestamp) {
        if (!this._sourceBuffer || this._sourceBuffer.updating) {
            this._hasPendingData = true;
            this._pendingData.push({ data: data, track: track, timestamp: timestamp });
            this._pendingDataSize += data.byteLength;
            return;
        }

        try {
            this._sourceBuffer.appendBuffer(data);
            this._pendingAppendLength = data.byteLength;
        } catch (e) {
            Log.e(this.TAG, 'Error appending media segment:', e);
            this._hasPendingData = true;
            this._pendingData.push({ data: data, track: track, timestamp: timestamp });
            this._pendingDataSize += data.byteLength;

            if (e.name === 'QuotaExceededError') {
                this._onBufferFull();
            } else {
                this.dispatchEvent(Events.ERROR, {
                    type: ErrorTypes.MEDIA_ERROR,
                    details: ErrorDetails.MSE_SOURCE_BUFFER_APPEND_EXCEPTION,
                    err: e
                });
            }
        }
    }

    _onMediaInfo(mediaInfo) {
        Log.v(this.TAG, 'MediaInfo received:', mediaInfo);

        // Enhanced media info handling with color metadata
        this.mediaInfo = mediaInfo;
        
        // Log enhanced metadata for debugging
        console.log('Enhanced Media Info:', {
            // Basic info
            width: mediaInfo.width,
            height: mediaInfo.height,
            fps: mediaInfo.fps,
            profile: mediaInfo.profile,
            level: mediaInfo.level,
            
            // New color metadata
            pix_fmt: mediaInfo.pix_fmt,
            color_range: mediaInfo.color_range,
            color_space: mediaInfo.color_space,
            color_transfer: mediaInfo.color_transfer,
            color_primaries: mediaInfo.color_primaries,
            frame_rate: mediaInfo.frame_rate,
            
            // Additional technical info
            chromaFormat: mediaInfo.chromaFormat,
            bitDepth: mediaInfo.bitDepth,
            videoCodec: mediaInfo.videoCodec,
            audioCodec: mediaInfo.audioCodec
        });

        // Update codec strings for MediaSource
        if (mediaInfo.videoCodec === 'avc') {
            this._videoCodec = `avc1.${mediaInfo.profile.toString(16).padStart(2, '0')}${mediaInfo.level.toString(16).padStart(2, '0')}`;
        }

        if (mediaInfo.audioCodec === 'aac') {
            this._audioCodec = 'mp4a.40.2';
        } else if (mediaInfo.audioCodec === 'mp3') {
            this._audioCodec = 'mp4a.6b';
        }

        // Emit enhanced MEDIA_INFO event
        this.dispatchEvent(Events.MEDIA_INFO, mediaInfo);
    }

    _onMetadata(metadata) {
        this.dispatchEvent(Events.METADATA_ARRIVED, metadata);
    }

    _onScriptData(scriptData) {
        this.dispatchEvent(Events.SCRIPTDATA_ARRIVED, scriptData);
    }

    _onTimedID3(id3) {
        this.dispatchEvent(Events.TIMED_ID3_METADATA_ARRIVED, id3);
    }

    _onError(type, info) {
        this.dispatchEvent(Events.ERROR, {
            type: type,
            details: info.details,
            err: info.err
        });
    }

    _appendPendingData() {
        if (!this._sourceBuffer || this._sourceBuffer.updating || this._pendingData.length === 0) {
            return;
        }

        let data = this._pendingData.shift();
        this._pendingDataSize -= data.data.byteLength;

        try {
            this._sourceBuffer.appendBuffer(data.data);
            this._pendingAppendLength = data.data.byteLength;
        } catch (e) {
            Log.e(this.TAG, 'Error appending pending data:', e);
            this._hasPendingData = true;
            this._pendingData.unshift(data);
            this._pendingDataSize += data.data.byteLength;

            if (e.name === 'QuotaExceededError') {
                this._onBufferFull();
            }
        }
    }

    feed(data) {
        if (this._transmuxer) {
            this._transmuxer.push(data);
        }
    }

    seek(milliseconds) {
        if (this._mediaElement && this._mediaSource.readyState === 'open') {
            this._mediaElement.currentTime = milliseconds / 1000;
        }
    }

    get mediaInfo() {
        return this._mediaInfo;
    }

    set mediaInfo(info) {
        this._mediaInfo = info;
    }

    get stats() {
        return this._stats;
    }
}

export default MSEController;
