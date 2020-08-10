import redio, { HTTPOptions, RedioEnd, Valve, end, isEnd, LotsOfLiquid, Spout } from 'redioactive'
import * as beamy from 'beamcoder'
import { Packet, Frame, Decoder, Encoder, Muxer, Stream, Filterer } from 'beamcoder'

let packetizer: Valve<Record<string, unknown>, Packet> = (t: Record<string, unknown> | RedioEnd) => {
    if (isEnd(t)) { console.log('Packetizer end') }
    return isEnd(t) ? end : beamy.packet(t as any)
}

let decodeFrames: () => Valve<Packet, Frame> = () => {
    let decoder: Decoder | null = null
    return async (t: Packet | RedioEnd) => {
        if (decoder === null) {
            decoder = beamy.decoder({ name: 'h264', width: 1920, height: 1080 })
        }
        if (isEnd(t)) { console.log('Decoder end'); return end }
        const decodedFrames = await decoder.decode(t)
        return decodedFrames.frames[0]
    }
}

let encodeFrames: () => Valve<Frame, Packet> = () => {
    let encoder: Encoder | null = null
    let flushed = false
    return async (t: Frame | RedioEnd): Promise<LotsOfLiquid<Packet>> => {
        if (encoder === null) {
            encoder = beamy.encoder({ 
                name: 'libvpx', 
                time_base: [1, 25],
                pix_fmt: 'yuv420p',
                width: 160,
                height: 90,
                bit_rate: 40000,
                priv_data: {
                    'auto-alt-ref': 0
                }
            })
        }
        if (isEnd(t)) {
            console.log('Encoder end')
            if (!flushed) {
                let result = await encoder.flush()
                flushed = true
                let packets: Array<Packet | RedioEnd> = result.packets
                packets.push(end)
                console.log('THE END', packets)
                return packets
            }
            return end
        }
        let result = await encoder.encode(t)
        return result.packets
    }
}

let formatFilter: () => Valve<Frame, Frame> = () => {
    let filter: Filterer | null = null
    return async (t: Frame | RedioEnd) => {
        if (isEnd(t)) { console.log('Format filter end'); return end }
        if (filter === null) {
            filter = await beamy.filterer({
                filterType: 'video',
                inputParams: [{
                    width: t.width,
                    height: t.height,
                    pixelFormat: t.format && t.format || 'yuv422p',
                    timeBase: [1, 25],
                    pixelAspect: [1, 1]
                }],
                outputParams: [{
                    pixelFormat: 'yuv420p'
                }],
                filterSpec: 'format=yuv420p'
            })
        }
        const filteredFrames = await filter.filter([t])
        // console.log(filteredFrames[0].name)
        return filteredFrames[0].frames[0]
    }
}

let scaleFilter: () => Valve<Frame, Frame> = () => {
    let filter: Filterer | null = null
    return async (t: Frame | RedioEnd) => {
        if (isEnd(t)) { console.log('Scale filter end'); return end }
        if (filter === null) {
            filter = await beamy.filterer({
                filterType: 'video',
                inputParams: [{
                    width: t.width,
                    height: t.height,
                    pixelFormat: 'yuv420p',
                    timeBase: [1, 25],
                    pixelAspect: [1, 1]
                }],
                outputParams: [{
                    pixelFormat: 'yuv420p'
                }],
                filterSpec: 'scale=160:-1'
            })
        }
        const filteredFrames = await filter.filter([t])
        // console.log(filteredFrames[0].name)
        return filteredFrames[0].frames[0]
    }
}

let muxFrames: () => Spout<Packet> = () => {
    let muxer: Muxer | null = null
    let vstream: Stream | null = null
    return async (t: Packet | RedioEnd): Promise<void> => {
        if (muxer === null) {
            muxer = beamy.muxer({ filename: 'miniski.webm' })
            vstream = muxer.newStream({ 
                name: 'libvpx', 
                r_frame_rate: [25, 1], 
                avg_frame_rate: [25, 1], 
                interleaved: false,
                duration: 1752
            })
            Object.assign(vstream.codecpar, {
                width: 160,
                height: 90,
                format: 'yuv420p',
                bit_rate: 40000
            })
            await muxer.openIO()
            await muxer.writeHeader()
        }
        if (isEnd(t)) {
            console.log('Muxer end')
            // console.dir(muxer, { depth: null, getters: true })
            muxer.writeTrailer()
            return
        }
        // console.log('Muxer stuff', muxer.streams[0].time_base, t.pts)
        t.pts = t.pts * 40
        await muxer.writeFrame(t)
    }
}

redio<Record<string, unknown>>('/my/video', { 
    blob: 'data', 
    httpPort: 8001,
    manifest: 'streamInfo'
} as HTTPOptions)
.valve<Packet>(packetizer)
.filter(x => x.stream_index === 0)
// .doto(x => console.log('>>>', x.pts))
.valve<Frame>(decodeFrames())
.valve<Frame>(formatFilter())
.valve<Frame>(scaleFilter())
.valve<Packet>(encodeFrames(), { oneToMany: true })
// .doto(x => console.log('<<<', x.pts))
.spout(muxFrames())