import {getTagged} from '../../deps/bp_logger.js';

import {RTSPClientSM as RTSPClient} from './client.js';
import {Url} from '../../core/util/url.js';

const LOG_TAG = "rtsp:stream";
const Log = getTagged(LOG_TAG);

export class RTSPStream {

    constructor(client, track) {
        this.state = null;
        this.client = client;
        this.track = track;
        this.rtpChannel = 1;

        this.stopKeepAlive();
        this.keepaliveInterval = null;
    }

    reset() {
        this.stopKeepAlive();
        this.client.forgetRTPChannel(this.rtpChannel);
        this.client = null;
        this.track = null;
    }

    start() {
        return this.sendSetup().then(this.sendPlay.bind(this));
    }

    stop() {
        return this.sendTeardown();
    }

    getSetupURL(track) {
        let sessionBlock = this.client.sdp.getSessionBlock();
        if (Url.isAbsolute(track.control)) {
            return track.control;
        } else if (Url.isAbsolute(`${sessionBlock.control}${track.control}`)) {
            return `${sessionBlock.control}${track.control}`;
        } else if (Url.isAbsolute(`${this.client.contentBase}${track.control}`)) {
            /* Should probably check session level control before this */
            return `${this.client.contentBase}${track.control}`;
        }
        else {//need return default
            return track.control;
        }
        Log.error('Can\'t determine track URL from ' +
            'block.control:' + track.control + ', ' +
            'session.control:' + sessionBlock.control + ', and ' +
            'content-base:' + this.client.contentBase);
    }

    getControlURL() {
        let ctrl = this.client.sdp.getSessionBlock().control;
        if (Url.isAbsolute(ctrl)) {
            return ctrl;
        } else if (!ctrl || '*' === ctrl) {
            return this.client.contentBase;
        } else {
            return `${this.client.contentBase}${ctrl}`;
        }
    }

    sendKeepalive() {
        return this.client.sendRequest('GET_PARAMETER', this.getSetupURL(this.track), {
            'Session': this.session
        });
    }

    stopKeepAlive() {
        clearInterval(this.keepaliveInterval);
    }

    startKeepAlive() {
        this.keepaliveInterval = setInterval(() => {
            this.sendKeepalive().catch((e) => {
                Log.error(e);
                this.client.reconnect();
            });
        }, 30000);
    }

    sendRequest(_cmd, _params = {}) {
        let params = {};
        if (this.session) {
            params['Session'] = this.session;
        }
        Object.assign(params, _params);
        return this.client.sendRequest(_cmd, this.getControlURL(), params);
    }

    sendSetup() {
        this.state = RTSPClient.STATE_SETUP;
        this.rtpChannel = this.client.interleaveChannelIndex;
        let interleavedChannels = this.client.interleaveChannelIndex++ + "-" + this.client.interleaveChannelIndex++;
        return this.client.sendRequest('SETUP', this.getSetupURL(this.track), {
            'Transport': `RTP/AVP/TCP;unicast;interleaved=${interleavedChannels}`,
            'Date': new Date().toUTCString()
        }).then((_data) => {
            this.session = _data.headers['session'];
            /*if (!/RTP\/AVP\/TCP;unicast;interleaved=/.test(_data.headers["transport"])) {
                // TODO: disconnect stream and notify client
                throw new Error("Connection broken");
            }*/
            this.startKeepAlive();
        });
    }

    sendPlay(pos = 0) {
        this.state = RTSPStream.STATE_PLAY;
        let params = {};
        let range = this.client.sdp.sessionBlock.range;
        if (range) {
            // TODO: seekable
            if (range[0] == -1) {
                range[0] = 0;// Do not handle now at the moment
            }
            // params['Range'] = `${range[2]}=${range[0]}-`;
        }
        this.client.useRTPChannel(this.rtpChannel);
        let data = this.sendRequest('PLAY', params);
        this.state = RTSPClient.STATE_PLAYING;
        return {track: this.track, data: data};
    }

    sendPause() {
        if (!this.client.supports("PAUSE")) {
            return;
        }
        this.state = RTSPClient.STATE_PAUSE;
        this.sendRequest("PAUSE");
        this.state = RTSPClient.STATE_PAUSED;
    }

    sendTeardown() {
        if (this.state != RTSPClient.STATE_TEARDOWN) {
            this.client.forgetRTPChannel(this.rtpChannel);
            this.state = RTSPClient.STATE_TEARDOWN;
            this.stopKeepAlive();
            this.sendRequest("TEARDOWN");
            Log.log('RTSPClient: STATE_TEARDOWN');
            ///this.client.connection.disconnect();
            // TODO: Notify client
        }
    }
}
