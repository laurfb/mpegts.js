import {
    BaseDemuxer,
    DemuxErrors,
    DemuxEvents
} from '../core/demuxer.js';
import {
    Log
} from '../utils/logger.js';
import {
    ByteArray
} from '../utils/byte-array.js';

class BitReader {
    constructor(data) {
        this.data = data;
        this.bitPosition = 0;
        this.bytePosition = 0;
    }

    readU(bits) {
        let value = 0;
        while (bits > 0) {
            if (this.bytePosition >= this.data.length) {
                throw new Error('BitReader: End of data');
            }
            
            const byte = this.data[this.bytePosition];
            const bitsLeftInByte = 8 - (this.bitPosition % 8);
            const bitsToRead = Math.min(bits, bitsLeftInByte);
            const shift = bitsLeftInByte - bitsToRead;
            const mask = (1 << bitsToRead) - 1;
            
            value <<= bitsToRead;
            value |= (byte >> shift) & mask;
            
            this.bitPosition += bitsToRead;
            this.bytePosition = Math.floor(this.bitPosition / 8);
            bits -= bitsToRead;
        }
        return value;
    }

    readUE() {
        let leadingZeroBits = 0;
        while (this.readU(1) === 0) {
            leadingZeroBits++;
            if (leadingZeroBits > 32) {
                throw new Error('BitReader: Too many leading zero bits');
            }
        }
        return (1 << leadingZeroBits) - 1 + this.readU(leadingZeroBits);
    }

    readSE() {
        const value = this.readUE();
        return value % 2 === 0 ? -(value / 2) : (value + 1) / 2;
    }

    skipBits(bits) {
        this.bitPosition += bits;
        this.bytePosition = Math.floor(this.bitPosition / 8);
    }

    alignToByte() {
        if (this.bitPosition % 8 !== 0) {
            this.bitPosition += 8 - (this.bitPosition % 8);
            this.bytePosition = Math.floor(this.bitPosition / 8);
        }
    }
}

class FLVDemuxer extends BaseDemuxer {
    constructor(probeDataSize) {
        super();
        
        this.TAG = 'FLVDemuxer';
        this._probeDataSize = probeDataSize || (1024 * 1024);
        
        this._hasAudio = false;
        this._hasVideo = false;
        this._hasKeyFrame = false;
        this._metadata = null;
        this._audioInitialMetadataDispatched = false;
        this._videoInitialMetadataDispatched = false;
        this._firstParse = true;
        this._dispatchFlag = false;

        // Audio/video statistics for bitrate calculation (ORIGINAL FUNCTIONALITY)
        this._audioBytes = 0;
        this._videoBytes = 0;
        this._beginTime = null;
        this._endTime = null;

        this._audioTrack = { type: 'audio', id: 0, sequenceNumber: 0 };
        this._videoTrack = { type: 'video', id: 1, sequenceNumber: 0 };

        // Enhanced media info with color metadata + ORIGINAL FIELDS
        this._mediaInfo = {
            hasAudio: false,
            hasVideo: false,
            audioCodec: null,
            videoCodec: null,
            audioDataRate: null,  // ORIGINAL: Audio bit rate
            videoDataRate: null,  // ORIGINAL: Video bit rate  
            audioSampleRate: null,
            audioChannelCount: null,
            width: null,
            height: null,
            fps: null,
            profile: null,
            level: null,
            chromaFormat: null,    // NEW
            bitDepth: null,        // NEW
            // New color metadata fields
            pix_fmt: null,
            color_range: null,
            color_space: null,
            color_transfer: null,
            color_primaries: null,
            frame_rate: null,
            // Raw SPS/PPS for advanced parsing
            sps: null,
            pps: null,
            // Detailed color info
            matrix_coefficients: null,
            transfer_characteristics: null,
            color_primaries_raw: null,
            video_format: null,
            // ORIGINAL: Reference to metadata
            metadata: null
        };

        // Frame rate calculation
        this._lastPTS = null;
        this._frameCount = 0;
        this._frameRateSamples = [];
        this._lastFrameTime = null;

        this._naluStartCode = new Uint8Array([0, 0, 0, 1]);
    }

    destroy() {
        // Clean up resources
    }

    parseChunks(chunk, byteStart, byteEnd) {
        if (this._firstParse) {
            this._firstParse = false;
            if (!this._parseFLVHeader(chunk)) {
                return DemuxErrors.FORMAT_ERROR;
            }
        }

        let offset = byteStart;
        while (offset + 15 <= byteEnd) {
            let previousTagSize = ByteArray.readUint32(chunk, offset);
            offset += 4;

            if (offset + 11 > byteEnd) {
                break;
            }

            let tagType = ByteArray.readUint8(chunk, offset) & 0x1F;
            let dataSize = ByteArray.readUint24(chunk, offset + 1);
            let timestamp = ByteArray.readUint24(chunk, offset + 4);
            let timestampExtended = ByteArray.readUint8(chunk, offset + 7);
            let streamId = ByteArray.readUint24(chunk, offset + 8);

            timestamp |= timestampExtended << 24;
            offset += 11;

            if (offset + dataSize > byteEnd) {
                break;
            }

            if (streamId !== 0) {
                offset += dataSize;
                continue;
            }

            // ORIGINAL: Track timing for bitrate calculation
            if (this._beginTime == null) {
                this._beginTime = timestamp;
            }
            this._endTime = timestamp;

            let success = true;
            switch (tagType) {
                case 8: // Audio
                    this._audioBytes += dataSize;  // ORIGINAL: Track audio bytes
                    success = this._parseAudioData(chunk, offset, dataSize, timestamp);
                    break;
                case 9: // Video
                    this._videoBytes += dataSize;  // ORIGINAL: Track video bytes
                    success = this._parseVideoData(chunk, offset, dataSize, timestamp);
                    break;
                case 18: // Script Data
                    success = this._parseScriptData(chunk, offset, dataSize, timestamp);
                    break;
                default:
                    Log.w(this.TAG, `Unknown tag type: ${tagType}`);
                    break;
            }

            if (!success) {
                return DemuxErrors.FORMAT_ERROR;
            }

            offset += dataSize;
        }

        // ORIGINAL: Calculate bitrates
        this._calculateBitrates();

        return offset - byteStart;
    }

    // ORIGINAL: Bitrate calculation method
    _calculateBitrates() {
        if (this._beginTime != null && this._endTime != null && this._endTime > this._beginTime) {
            let duration = (this._endTime - this._beginTime) / 1000; // in seconds
            
            if (this._audioBytes > 0 && duration > 0) {
                this._mediaInfo.audioDataRate = Math.round((this._audioBytes * 8) / duration / 1000); // kbps
            }
            
            if (this._videoBytes > 0 && duration > 0) {
                this._mediaInfo.videoDataRate = Math.round((this._videoBytes * 8) / duration / 1000); // kbps
            }
        }
    }

    _parseFLVHeader(data) {
        if (data.length < 9) return false;

        let signature = String.fromCharCode(data[0], data[1], data[2]);
        if (signature !== 'FLV') {
            return false;
        }

        let version = data[3];
        let flags = data[4];
        this._hasAudio = (flags & 0x04) !== 0;
        this._hasVideo = (flags & 0x01) !== 0;

        this._mediaInfo.hasAudio = this._hasAudio;
        this._mediaInfo.hasVideo = this._hasVideo;

        return true;
    }

    _parseAudioData(data, offset, length, timestamp) {
        if (length < 1) return false;

        let soundFormat = (data[offset] & 0xF0) >>> 4;
        let soundRate = (data[offset] & 0x0C) >>> 2;
        let soundSize = (data[offset] & 0x02) >>> 1;
        let soundType = data[offset] & 0x01;
        offset++;
        length--;

        // ORIGINAL: Handle AAC sequence header for audio config
        if (soundFormat === 10) { // AAC
            if (length > 1) {
                let aacPacketType = data[offset];
                if (aacPacketType === 0) { // AAC sequence header
                    // Parse AudioSpecificConfig if needed
                    this._parseAACSequenceHeader(data, offset + 1, length - 1);
                }
            }
        }

        if (soundFormat !== 10 && soundFormat !== 2) { // AAC or MP3
            return true;
        }

        if (!this._audioInitialMetadataDispatched) {
            this._mediaInfo.audioCodec = soundFormat === 10 ? 'aac' : 'mp3';
            this._mediaInfo.audioSampleRate = [5500, 11025, 22050, 44100][soundRate];
            this._mediaInfo.audioChannelCount = soundType + 1;
            this._dispatchMediaInfo();
            this._audioInitialMetadataDispatched = true;
        }

        if (this.onData) {
            let audioData = new Uint8Array(data.buffer, data.byteOffset + offset, length);
            this.onData(this._audioTrack, audioData, timestamp, timestamp);
        }

        return true;
    }

    // ORIGINAL: AAC sequence header parsing (simplified)
    _parseAACSequenceHeader(data, offset, length) {
        // This is where you could parse AudioSpecificConfig for more detailed audio info
        // For now, we'll just note that we have AAC audio
        if (length >= 2) {
            let audioObjectType = (data[offset] & 0xF8) >>> 3;
            let samplingFrequencyIndex = ((data[offset] & 0x07) << 1) | ((data[offset + 1] & 0x80) >>> 7);
            let channelConfiguration = (data[offset + 1] & 0x78) >>> 3;
            
            // Could store this info in mediaInfo if needed
        }
    }

    _parseVideoData(data, offset, length, timestamp) {
        if (length < 1) return false;

        let frameType = (data[offset] & 0xF0) >>> 4;
        let codecId = data[offset] & 0x0F;
        offset++;
        length--;

        if (codecId !== 7) { // Only support AVC/H.264
            return true;
        }

        if (frameType === 5) { // Video info/command frame
            return true;
        }

        let avcPacketType = data[offset];
        let compositionTime = ByteArray.readUint24(data, offset + 1);
        offset += 4;
        length -= 4;

        compositionTime = (compositionTime + 0xFF800000) ^ 0xFF800000;

        if (avcPacketType === 0) { // AVC sequence header
            this._parseAVCDecoderConfigurationRecord(data, offset, length);
        } else if (avcPacketType === 1) { // AVC NALU
            this._parseAVCNALU(data, offset, length, timestamp, compositionTime, frameType);
        } else if (avcPacketType === 2) { // AVC end of sequence
            // Ignore
        }

        return true;
    }

    _parseAVCDecoderConfigurationRecord(data, offset, length) {
        if (length < 7) return;

        let configurationVersion = data[offset];
        let avcProfileIndication = data[offset + 1];
        let profileCompatibility = data[offset + 2];
        let avcLevelIndication = data[offset + 3];
        let lengthSizeMinusOne = data[offset + 4] & 0x03;

        this._mediaInfo.videoCodec = 'avc';
        this._mediaInfo.profile = avcProfileIndication;
        this._mediaInfo.level = avcLevelIndication;

        let spsCount = data[offset + 5] & 0x1F;
        offset += 6;
        length -= 6;

        for (let i = 0; i < spsCount; i++) {
            if (length < 2) break;
            let spsLength = ByteArray.readUint16(data, offset);
            offset += 2;
            length -= 2;

            if (spsLength > 0 && length >= spsLength) {
                let sps = new Uint8Array(data.buffer, data.byteOffset + offset, spsLength);
                this._mediaInfo.sps = sps;
                this._parseSPS(sps);
                offset += spsLength;
                length -= spsLength;
            }
        }

        if (length < 1) return;
        let ppsCount = data[offset];
        offset++;
        length--;

        for (let i = 0; i < ppsCount; i++) {
            if (length < 2) break;
            let ppsLength = ByteArray.readUint16(data, offset);
            offset += 2;
            length -= 2;

            if (ppsLength > 0 && length >= ppsLength) {
                let pps = new Uint8Array(data.buffer, data.byteOffset + offset, ppsLength);
                this._mediaInfo.pps = pps;
                offset += ppsLength;
                length -= ppsLength;
            }
        }

        this._dispatchMediaInfo();
    }

    _parseSPS(sps) {
        if (!sps || sps.length < 4) return null;
        
        try {
            const rbsp = this._ebsp2rbsp(sps);
            const bitReader = new BitReader(rbsp);
            
            // Skip NAL unit header
            bitReader.readU(8); // forbidden_zero_bit + nal_ref_idc + nal_unit_type
            
            const profile_idc = bitReader.readU(8);
            const constraint_flags = bitReader.readU(8);
            const level_idc = bitReader.readU(8);
            
            let seq_parameter_set_id = bitReader.readUE();
            
            // Parse chroma format
            let chroma_format_idc = 1; // Default 4:2:0
            let separate_colour_plane_flag = false;
            let bit_depth_luma_minus8 = 0;
            let bit_depth_chroma_minus8 = 0;
            
            if (profile_idc === 100 || profile_idc === 110 ||
                profile_idc === 122 || profile_idc === 244 ||
                profile_idc === 44 || profile_idc === 83 ||
                profile_idc === 86 || profile_idc === 118 ||
                profile_idc === 128) {
                
                chroma_format_idc = bitReader.readUE();
                if (chroma_format_idc === 3) {
                    separate_colour_plane_flag = bitReader.readU(1) === 1;
                }
                
                bit_depth_luma_minus8 = bitReader.readUE();
                bit_depth_chroma_minus8 = bitReader.readUE();
                bitReader.readU(1); // qpprime_y_zero_transform_bypass_flag
                
                const seq_scaling_matrix_present_flag = bitReader.readU(1);
                if (seq_scaling_matrix_present_flag) {
                    const count = chroma_format_idc !== 3 ? 8 : 12;
                    for (let i = 0; i < count; i++) {
                        const seq_scaling_list_present_flag = bitReader.readU(1);
                        if (seq_scaling_list_present_flag) {
                            if (i < 6) {
                                this._skipScalingList(bitReader, 16);
                            } else {
                                this._skipScalingList(bitReader, 64);
                            }
                        }
                    }
                }
            }
            
            const log2_max_frame_num_minus4 = bitReader.readUE();
            const pic_order_cnt_type = bitReader.readUE();
            
            if (pic_order_cnt_type === 0) {
                const log2_max_pic_order_cnt_lsb_minus4 = bitReader.readUE();
            } else if (pic_order_cnt_type === 1) {
                bitReader.readU(1); // delta_pic_order_always_zero_flag
                bitReader.readSE(); // offset_for_non_ref_pic
                bitReader.readSE(); // offset_for_top_to_bottom_field
                const num_ref_frames_in_pic_order_cnt_cycle = bitReader.readUE();
                for (let i = 0; i < num_ref_frames_in_pic_order_cnt_cycle; i++) {
                    bitReader.readSE(); // offset_for_ref_frame[i]
                }
            }
            
            const max_num_ref_frames = bitReader.readUE();
            const gaps_in_frame_num_value_allowed_flag = bitReader.readU(1);
            
            const pic_width_in_mbs_minus1 = bitReader.readUE();
            const pic_height_in_map_units_minus1 = bitReader.readUE();
            
            const frame_mbs_only_flag = bitReader.readU(1);
            if (!frame_mbs_only_flag) {
                bitReader.readU(1); // mb_adaptive_frame_field_flag
            }
            
            const direct_8x8_inference_flag = bitReader.readU(1);
            
            // Update dimensions
            this._mediaInfo.width = (pic_width_in_mbs_minus1 + 1) * 16;
            this._mediaInfo.height = ((2 - frame_mbs_only_flag) * (pic_height_in_map_units_minus1 + 1)) * 16;
            
            const frame_cropping_flag = bitReader.readU(1);
            if (frame_cropping_flag) {
                const frame_crop_left_offset = bitReader.readUE();
                const frame_crop_right_offset = bitReader.readUE();
                const frame_crop_top_offset = bitReader.readUE();
                const frame_crop_bottom_offset = bitReader.readUE();
                
                this._mediaInfo.width -= (frame_crop_left_offset + frame_crop_right_offset) * 2;
                this._mediaInfo.height -= (frame_crop_top_offset + frame_crop_bottom_offset) * 2;
            }
            
            // VUI parameters
            const vui_parameters_present_flag = bitReader.readU(1);
            if (vui_parameters_present_flag) {
                this._parseVUIParameters(bitReader);
            }
            
            // Update color metadata
            this._updateColorMetadata(
                chroma_format_idc,
                bit_depth_luma_minus8,
                bit_depth_chroma_minus8
            );
            
            return {
                chroma_format_idc,
                separate_colour_plane_flag,
                bit_depth_luma_minus8,
                bit_depth_chroma_minus8
            };
        } catch (e) {
            Log.w(this.TAG, 'SPS parsing error:', e);
            return null;
        }
    }

    _parseVUIParameters(bitReader) {
        const aspect_ratio_info_present_flag = bitReader.readU(1);
        if (aspect_ratio_info_present_flag) {
            const aspect_ratio_idc = bitReader.readU(8);
            if (aspect_ratio_idc === 255) { // Extended_SAR
                bitReader.readU(16); // sar_width
                bitReader.readU(16); // sar_height
            }
        }
        
        const overscan_info_present_flag = bitReader.readU(1);
        if (overscan_info_present_flag) {
            bitReader.readU(1); // overscan_appropriate_flag
        }
        
        const video_signal_type_present_flag = bitReader.readU(1);
        if (video_signal_type_present_flag) {
            const video_format = bitReader.readU(3);
            const video_full_range_flag = bitReader.readU(1);
            const colour_description_present_flag = bitReader.readU(1);
            
            let colour_primaries = 2; // Default: unspecified
            let transfer_characteristics = 2; // Default: unspecified
            let matrix_coefficients = 2; // Default: unspecified
            
            if (colour_description_present_flag) {
                colour_primaries = bitReader.readU(8);
                transfer_characteristics = bitReader.readU(8);
                matrix_coefficients = bitReader.readU(8);
            }
            
            // Update media info with color metadata
            this._mediaInfo.video_format = video_format;
            this._mediaInfo.color_range = video_full_range_flag ? 'full' : 'limited';
            this._mediaInfo.color_primaries_raw = colour_primaries;
            this._mediaInfo.transfer_characteristics = transfer_characteristics;
            this._mediaInfo.matrix_coefficients = matrix_coefficients;
            
            // Convert to standard names
            this._mediaInfo.color_primaries = this._getColorPrimariesName(colour_primaries);
            this._mediaInfo.color_transfer = this._getTransferCharacteristicsName(transfer_characteristics);
            this._mediaInfo.color_space = this._getMatrixCoefficientsName(matrix_coefficients);
        }
        
        const chroma_loc_info_present_flag = bitReader.readU(1);
        if (chroma_loc_info_present_flag) {
            bitReader.readUE(); // chroma_sample_loc_type_top_field
            bitReader.readUE(); // chroma_sample_loc_type_bottom_field
        }
        
        const timing_info_present_flag = bitReader.readU(1);
        if (timing_info_present_flag) {
            const num_units_in_tick = bitReader.readU(32);
            const time_scale = bitReader.readU(32);
            const fixed_frame_rate_flag = bitReader.readU(1);
            
            if (num_units_in_tick > 0 && time_scale > 0) {
                const fps = time_scale / (2.0 * num_units_in_tick);
                this._mediaInfo.frame_rate = fps;
                this._mediaInfo.fps = fps;
            }
        }
        
        // Skip remaining VUI parameters
        const nal_hrd_parameters_present_flag = bitReader.readU(1);
        if (nal_hrd_parameters_present_flag) {
            this._skipHRDParameters(bitReader);
        }
        
        const vcl_hrd_parameters_present_flag = bitReader.readU(1);
        if (vcl_hrd_parameters_present_flag) {
            this._skipHRDParameters(bitReader);
        }
        
        if (nal_hrd_parameters_present_flag || vcl_hrd_parameters_present_flag) {
            bitReader.readU(1); // low_delay_hrd_flag
        }
        
        bitReader.readU(1); // pic_struct_present_flag
        
        const bitstream_restriction_flag = bitReader.readU(1);
        if (bitstream_restriction_flag) {
            bitReader.readU(1); // motion_vectors_over_pic_boundaries_flag
            bitReader.readUE(); // max_bytes_per_pic_denom
            bitReader.readUE(); // max_bits_per_mb_denom
            bitReader.readUE(); // log2_max_mv_length_horizontal
            bitReader.readUE(); // log2_max_mv_length_vertical
            bitReader.readUE(); // max_num_reorder_frames
            bitReader.readUE(); // max_dec_frame_buffering
        }
    }

    _skipHRDParameters(bitReader) {
        const cpb_cnt_minus1 = bitReader.readUE();
        bitReader.readU(4); // bit_rate_scale
        bitReader.readU(4); // cpb_size_scale
        
        for (let i = 0; i <= cpb_cnt_minus1; i++) {
            bitReader.readUE(); // bit_rate_value_minus1[i]
            bitReader.readUE(); // cpb_size_value_minus1[i]
            bitReader.readU(1); // cbr_flag[i]
        }
        
        bitReader.readU(5); // initial_cpb_removal_delay_length_minus1
        bitReader.readU(5); // cpb_removal_delay_length_minus1
        bitReader.readU(5); // dpb_output_delay_length_minus1
        bitReader.readU(5); // time_offset_length
    }

    _skipScalingList(bitReader, size) {
        let lastScale = 8;
        let nextScale = 8;
        let deltaScale;
        
        for (let i = 0; i < size; i++) {
            if (nextScale !== 0) {
                deltaScale = bitReader.readSE();
                nextScale = (lastScale + deltaScale + 256) % 256;
            }
            lastScale = (nextScale === 0) ? lastScale : nextScale;
        }
    }

    _updateColorMetadata(chroma_format_idc, bit_depth_luma_minus8, bit_depth_chroma_minus8) {
        // Determine pixel format
        let pix_fmt = 'yuv420p';
        const bitDepth = bit_depth_luma_minus8 + 8;
        
        switch (chroma_format_idc) {
            case 1: // 4:2:0
                pix_fmt = bitDepth > 8 ? 'yuv420p10le' : 'yuv420p';
                this._mediaInfo.chromaFormat = '4:2:0';
                break;
            case 2: // 4:2:2
                pix_fmt = bitDepth > 8 ? 'yuv422p10le' : 'yuv422p';
                this._mediaInfo.chromaFormat = '4:2:2';
                break;
            case 3: // 4:4:4
                pix_fmt = bitDepth > 8 ? 'yuv444p10le' : 'yuv444p';
                this._mediaInfo.chromaFormat = '4:4:4';
                break;
            default: // 0 (monochrome) or unknown
                pix_fmt = bitDepth > 8 ? 'yuv420p10le' : 'yuv420p';
                this._mediaInfo.chromaFormat = '4:2:0';
                break;
        }
        
        this._mediaInfo.pix_fmt = pix_fmt;
        this._mediaInfo.bitDepth = bitDepth;
    }

    _getColorPrimariesName(code) {
        const primaries = {
            1: 'bt709',
            2: 'unspecified',
            4: 'bt470m',
            5: 'bt470bg',
            6: 'smpte170m',
            7: 'smpte240m',
            8: 'film',
            9: 'bt2020',
            10: 'smpte428',
            11: 'smpte431',
            12: 'smpte432',
            22: 'jedec-p22'
        };
        return primaries[code] || 'unknown';
    }

    _getTransferCharacteristicsName(code) {
        const transfer = {
            1: 'bt709',
            2: 'unspecified',
            4: 'gamma22',
            5: 'gamma28',
            6: 'smpte170m',
            7: 'smpte240m',
            8: 'linear',
            9: 'log100',
            10: 'log316',
            11: 'iec61966-2-4',
            12: 'bt1361e',
            13: 'srgb',
            14: 'bt2020-10',
            15: 'bt2020-12',
            16: 'smpte2084',
            17: 'smpte428',
            18: 'hlg'
        };
        return transfer[code] || 'unknown';
    }

    _getMatrixCoefficientsName(code) {
        const matrix = {
            0: 'gbrap',
            1: 'bt709',
            2: 'unspecified',
            4: 'fcc',
            5: 'bt470bg',
            6: 'smpte170m',
            7: 'smpte240m',
            8: 'ycgco',
            9: 'bt2020nc',
            10: 'bt2020c',
            12: 'smpte2085',
            13: 'chroma-derived-nc',
            14: 'chroma-derived-c',
            15: 'ictcp'
        };
        return matrix[code] || 'unknown';
    }

    _parseAVCNALU(data, offset, length, timestamp, compositionTime, frameType) {
        let dts = timestamp;
        let pts = timestamp + compositionTime;
        
        // Calculate frame rate from PTS
        this._calculateFrameRate(pts);
        
        if (this.onData) {
            let videoData = new Uint8Array(data.buffer, data.byteOffset + offset, length);
            
            // Check if this is a keyframe
            if (frameType === 1) {
                this._hasKeyFrame = true;
            }
            
            this.onData(this._videoTrack, videoData, pts, dts);
        }
        
        if (this.onTimestamp) {
            this.onTimestamp(pts, dts);
        }
    }

    _calculateFrameRate(pts) {
        const now = performance.now();
        
        if (this._lastPTS !== null && this._lastFrameTime !== null) {
            const ptsDelta = pts - this._lastPTS;
            const timeDelta = now - this._lastFrameTime;
            
            if (ptsDelta > 0 && timeDelta > 0) {
                // Calculate frame rate from PTS delta (90kHz clock)
                const frameRateFromPTS = 90000 / ptsDelta;
                
                // Calculate frame rate from time delta
                const frameRateFromTime = 1000 / timeDelta;
                
                // Use weighted average for stability
                const frameRate = (frameRateFromPTS * 0.7) + (frameRateFromTime * 0.3);
                
                this._frameRateSamples.push(frameRate);
                
                // Keep only recent samples for stability
                if (this._frameRateSamples.length > 30) {
                    this._frameRateSamples.shift();
                }
                
                // Calculate average frame rate when we have enough samples
                if (this._frameRateSamples.length >= 5) {
                    const sum = this._frameRateSamples.reduce((a, b) => a + b, 0);
                    const avgFrameRate = sum / this._frameRateSamples.length;
                    
                    this._mediaInfo.frame_rate = avgFrameRate;
                    this._mediaInfo.fps = avgFrameRate;
                    
                    // Update media info if frame rate changed significantly
                    if (Math.abs(avgFrameRate - (this._mediaInfo._lastReportedFrameRate || 0)) > 0.5) {
                        this._mediaInfo._lastReportedFrameRate = avgFrameRate;
                        this._dispatchMediaInfo();
                    }
                }
            }
        }
        
        this._lastPTS = pts;
        this._lastFrameTime = now;
        this._frameCount++;
    }

    _parseScriptData(data, offset, length, timestamp) {
        try {
            let name = this._parseAMFData(data, offset, length);
            let nameLength = name.consumed;
            offset += nameLength;
            length -= nameLength;

            let value = this._parseAMFData(data, offset, length);
            this._metadata = value.data;

            // ORIGINAL: Store metadata reference
            this._mediaInfo.metadata = this._metadata;

            if (this._metadata) {
                // ORIGINAL: Extract width/height from metadata
                if (this._metadata.width && this._metadata.height) {
                    this._mediaInfo.width = this._metadata.width;
                    this._mediaInfo.height = this._metadata.height;
                }

                // ORIGINAL: Extract framerate from metadata  
                if (this._metadata.framerate) {
                    this._mediaInfo.fps = this._metadata.framerate;
                    this._mediaInfo.frame_rate = this._metadata.framerate;
                }

                // ORIGINAL: Extract other metadata fields if present
                if (this._metadata.videocodecid) {
                    // Could map to codec info
                }
                if (this._metadata.audiocodecid) {
                    // Could map to codec info
                }
            }

            if (this.onScriptData) {
                this.onScriptData(this._metadata);
            }

            this._dispatchMediaInfo();
        } catch (e) {
            Log.w(this.TAG, 'Script data parsing error:', e);
        }

        return true;
    }

    _parseAMFData(data, offset, length) {
        // ... (same as previous version, kept for brevity)
        // [Include the exact same _parseAMFData method from previous version]
    }

    _dispatchMediaInfo() {
        if (!this.onMediaInfo || this._dispatchFlag) return;

        // Set default values for color metadata if not parsed
        const enhancedInfo = {
            ...this._mediaInfo,
            pix_fmt: this._mediaInfo.pix_fmt || 'yuv420p',
            color_range: this._mediaInfo.color_range || 'limited',
            color_space: this._mediaInfo.color_space || 'bt709',
            color_transfer: this._mediaInfo.color_transfer || 'bt709',
            color_primaries: this._mediaInfo.color_primaries || 'bt709',
            frame_rate: this._mediaInfo.frame_rate || this._mediaInfo.fps || 0,
            chromaFormat: this._mediaInfo.chromaFormat || '4:2:0',
            bitDepth: this._mediaInfo.bitDepth || 8,
            // ORIGINAL: Ensure original fields are preserved
            metadata: this._mediaInfo.metadata
        };

        // Remove internal properties
        delete enhancedInfo._lastPTS;
        delete enhancedInfo._frameCount;
        delete enhancedInfo._frameRateSamples;
        delete enhancedInfo._lastFrameTime;
        delete enhancedInfo._lastReportedFrameRate;

        this.onMediaInfo(enhancedInfo);
        this._dispatchFlag = true;
    }

    _ebsp2rbsp(ebsp) {
        let rbsp = [];
        let i = 0;

        while (i < ebsp.length) {
            if (i + 2 < ebsp.length &&
                ebsp[i] === 0x00 &&
                ebsp[i + 1] === 0x00 &&
                ebsp[i + 2] === 0x03) {
                rbsp.push(0x00);
                rbsp.push(0x00);
                i += 3;
            } else {
                rbsp.push(ebsp[i]);
                i++;
            }
        }

        return new Uint8Array(rbsp);
    }
}

export default FLVDemuxer;
