# syntax=docker/dockerfile:1
#
# One image for the CLI and the server:
#   docker run --rm -p 3000:3000 vd-oprezer                     # server (default)
#   docker run --rm -v "$PWD:/data" -w /data vd-oprezer convert clip.mov -p ecommerce
#
# docker build -t vd-oprezer .                 # runtime image
# docker build --target test .                 # runs npm test on Linux, against this FFmpeg

ARG NODE_IMAGE=node:24.22.1-alpine3.24
ARG ALPINE_IMAGE=alpine:3.24

# ---------------------------------------------------------------------------
# Minimal static FFmpeg: everything disabled, then only what vd-oprezer uses.
# Static (musl) binaries, so they run on any base image.
# Adding an input format = add its demuxer/decoder/parser below and rebuild.
FROM ${ALPINE_IMAGE} AS ffmpeg
ARG FFMPEG_VERSION=9.0.2
ARG X264_COMMIT=b35605ace3ddf7c1a5d67a2eb553f034aef41d55
# bash: x264's configure needs it. Build stage only; none of this reaches the final image.
RUN apk add --no-cache build-base nasm pkgconf curl xz bash
WORKDIR /src

RUN curl -fsSL "https://code.videolan.org/videolan/x264/-/archive/${X264_COMMIT}/x264-${X264_COMMIT}.tar.bz2" | tar xj \
 && cd "x264-${X264_COMMIT}" \
 && ./configure --prefix=/opt/x264 --enable-static --enable-pic --disable-cli \
 && make -j"$(nproc)" && make install

RUN curl -fsSL "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" | tar xJ \
 && cd "ffmpeg-${FFMPEG_VERSION}" \
 && PKG_CONFIG_PATH=/opt/x264/lib/pkgconfig ./configure \
      --prefix=/opt/ffmpeg \
      --enable-gpl --enable-libx264 \
      --enable-static --disable-shared --pkg-config-flags=--static --extra-ldflags=-static \
      --disable-everything --disable-autodetect --disable-network \
      --disable-doc --disable-debug --disable-ffplay \
      --enable-ffmpeg --enable-ffprobe \
      --enable-protocol=file,pipe \
      --enable-demuxer=mov,matroska,avi,mpegts,mpegps,flv,ogg,wav \
      --enable-muxer=mp4,mov \
      --enable-decoder=h264,hevc,vp8,vp9,prores,mpeg4,mpeg2video,mjpeg,aac,mp3float,mp3,opus,vorbis,flac,alac,ac3,eac3,pcm_s16le,pcm_s16be,pcm_s24le,pcm_f32le,wrapped_avframe \
      --enable-parser=h264,hevc,vp8,vp9,mpeg4video,mpegvideo,mjpeg,aac,mpegaudio,opus,vorbis,flac,ac3 \
      --enable-encoder=libx264,aac \
      --enable-bsf=aac_adtstoasc,extract_extradata,h264_mp4toannexb,hevc_mp4toannexb,vp9_superframe_split \
      --enable-filter=scale,fps,aresample,transpose,hflip,vflip,loop,testsrc2,sine \
      --enable-indev=lavfi \
 && make -j"$(nproc)" && make install \
 && strip /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe
# lavfi, testsrc2, sine and loop are only there so the test suite can generate
# its clips with this same FFmpeg; together they add a few KB.

# ---------------------------------------------------------------------------
# Bundle the CLI and the server into one file each, so the runtime image
# needs no node_modules (they were 30 MB).
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json eslint.config.js modules.config.js ./
COPY scripts ./scripts
COPY src ./src
RUN npm run bundle

# ---------------------------------------------------------------------------
# docker build --target test . : the full check on Linux with the real FFmpeg,
# including the tests Windows skips (CLI Ctrl+C, server SIGTERM), then a
# smoke test of the bundles themselves (the tests run the TypeScript source).
FROM build AS test
COPY --from=ffmpeg /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe /usr/local/bin/
RUN npm run check
RUN node dist-bundle/cli/main.js version \
 && (PORT=3999 node dist-bundle/server/main.js > /tmp/server.log & sleep 2) \
 && wget -qO- http://127.0.0.1:3999/presets | grep -q ecommerce

# ---------------------------------------------------------------------------
# Plain Alpine plus the node binary: the node image also carries npm and yarn
# (~40 MB) that nothing needs at runtime. Same Alpine release, so musl matches.
FROM ${NODE_IMAGE} AS node
FROM ${ALPINE_IMAGE}
RUN apk add --no-cache libstdc++ && adduser -D -u 1000 node
COPY --from=node /usr/local/bin/node /usr/local/bin/
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 WORK_DIR=/tmp/vd
WORKDIR /app
COPY --from=ffmpeg /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe /usr/local/bin/
COPY --from=build /app/dist-bundle ./dist
# main.ts reads the version from package.json.
COPY package.json ./
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/vd-oprezer
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO /dev/null "http://127.0.0.1:${PORT}/health" || exit 1
ENTRYPOINT ["vd-oprezer"]
CMD ["serve"]
