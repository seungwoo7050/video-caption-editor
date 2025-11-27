import { useCallback, useEffect, useRef, useState } from 'react';

import type { WebglResources } from '../types';
import type { RefObject } from 'react';

export type UseWebglPreviewOptions = {
  videoRef: RefObject<HTMLVideoElement | null>;
  videoUrl?: string | null;
};

export function useWebglPreview({ videoRef, videoUrl }: UseWebglPreviewOptions) {
  const webglCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const webglContainerRef = useRef<HTMLDivElement | null>(null);
  const webglResourcesRef = useRef<WebglResources | null>(null);
  const webglVideoFrameRequestIdRef = useRef<number | null>(null);
  const webglAnimationFrameIdRef = useRef<number | null>(null);
  const [isWebglSupported, setIsWebglSupported] = useState(true);
  const [isWebglReady, setIsWebglReady] = useState(false);
  const [isGrayscale, setIsGrayscale] = useState(false);

  const stopWebglRenderLoop = useCallback(() => {
    const video = videoRef.current;
    if (
      video &&
      typeof video.cancelVideoFrameCallback === 'function' &&
      webglVideoFrameRequestIdRef.current !== null
    ) {
      video.cancelVideoFrameCallback(webglVideoFrameRequestIdRef.current);
    }
    if (webglAnimationFrameIdRef.current !== null) {
      window.cancelAnimationFrame(webglAnimationFrameIdRef.current);
    }
    webglVideoFrameRequestIdRef.current = null;
    webglAnimationFrameIdRef.current = null;
  }, [videoRef]);

  const renderWebglFrame = useCallback(() => {
    const resources = webglResourcesRef.current;
    const canvas = webglCanvasRef.current;
    const video = videoRef.current;
    if (!resources || !canvas || !video) return;

    const gl = resources.gl;

    const dpr = window.devicePixelRatio || 1;
    const targetWidth = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const targetHeight = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }

    const videoWidth = video.videoWidth || video.width || 0;
    const videoHeight = video.videoHeight || video.height || 0;
    if (videoWidth === 0 || videoHeight === 0) return;

    const canvasAspect = targetWidth / targetHeight;
    const videoAspect = videoWidth / videoHeight;
    let scaleX = 1;
    let scaleY = 1;
    if (videoAspect > canvasAspect) {
      scaleY = canvasAspect / videoAspect;
    } else {
      scaleX = videoAspect / canvasAspect;
    }

    gl.viewport(0, 0, targetWidth, targetHeight);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(resources.program);

    gl.bindBuffer(gl.ARRAY_BUFFER, resources.positionBuffer);
    gl.enableVertexAttribArray(resources.attributes.position);
    gl.vertexAttribPointer(resources.attributes.position, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, resources.texCoordBuffer);
    gl.enableVertexAttribArray(resources.attributes.texCoord);
    gl.vertexAttribPointer(resources.attributes.texCoord, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, resources.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    } catch {
      return;
    }

    if (resources.uniforms.texture) gl.uniform1i(resources.uniforms.texture, 0);
    if (resources.uniforms.scale) gl.uniform2f(resources.uniforms.scale, scaleX, scaleY);
    if (resources.uniforms.grayscale) gl.uniform1i(resources.uniforms.grayscale, isGrayscale ? 1 : 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }, [isGrayscale, videoRef]);

  const scheduleWebglRenderLoop = useCallback(() => {
    const video = videoRef.current;
    if (!video || !webglResourcesRef.current) return;

    stopWebglRenderLoop();

    if (typeof video.requestVideoFrameCallback === 'function') {
      const tick: VideoFrameRequestCallback = () => {
        renderWebglFrame();
        webglVideoFrameRequestIdRef.current = video.requestVideoFrameCallback(tick);
      };

      webglVideoFrameRequestIdRef.current = video.requestVideoFrameCallback(tick);
      return;
    }

    if (video.paused || video.ended) {
      renderWebglFrame();
      return;
    }

    const loop = () => {
      renderWebglFrame();
      if (!video.paused && !video.ended) {
        webglAnimationFrameIdRef.current = window.requestAnimationFrame(loop);
      } else {
        webglAnimationFrameIdRef.current = null;
      }
    };

    renderWebglFrame();
    webglAnimationFrameIdRef.current = window.requestAnimationFrame(loop);
  }, [renderWebglFrame, stopWebglRenderLoop, videoRef]);

  const cleanupWebglResources = useCallback(() => {
    stopWebglRenderLoop();
    const resources = webglResourcesRef.current;
    if (!resources) return;

    const { gl, program, positionBuffer, texCoordBuffer, texture } = resources;
    try {
      gl.deleteBuffer(positionBuffer);
      gl.deleteBuffer(texCoordBuffer);
      gl.deleteTexture(texture);
      gl.deleteProgram(program);
    } catch (error) {
      console.error('[webgl] cleanup failed', error);
    }

    webglResourcesRef.current = null;
    setIsWebglReady(false);
  }, [stopWebglRenderLoop]);

  const initWebgl = useCallback(() => {
    cleanupWebglResources();

    const canvas = webglCanvasRef.current;
    const videoElement = videoRef.current;
    if (!canvas || !videoElement || !videoUrl) return;

    setIsWebglSupported(true);

    const gl =
      (canvas.getContext('webgl', { premultipliedAlpha: false }) as WebGLRenderingContext | null) ||
      (canvas.getContext('experimental-webgl', { premultipliedAlpha: false }) as
        | WebGLRenderingContext
        | null);
    if (!gl) {
      setIsWebglSupported(false);
      return;
    }

    const compileShader = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('Failed to create shader');
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`Failed to compile shader: ${info ?? 'unknown error'}`);
      }
      return shader;
    };

    const vertexShaderSource = `
      attribute vec2 a_position;
      attribute vec2 a_texCoord;
      varying vec2 v_texCoord;
      uniform vec2 u_scale;
      void main() {
        vec2 scaled = a_position * u_scale;
        gl_Position = vec4(scaled, 0.0, 1.0);
        v_texCoord = a_texCoord;
      }
    `;

    const fragmentShaderSource = `
      precision mediump float;
      varying vec2 v_texCoord;
      uniform sampler2D u_texture;
      uniform bool u_grayscale;
      void main() {
        vec4 color = texture2D(u_texture, v_texCoord);
        if (u_grayscale) {
          float g = dot(color.rgb, vec3(0.299, 0.587, 0.114));
          gl_FragColor = vec4(vec3(g), color.a);
        } else {
          gl_FragColor = color;
        }
      }
    `;

    try {
      const vertexShader = compileShader(gl.VERTEX_SHADER, vertexShaderSource);
      const fragmentShader = compileShader(gl.FRAGMENT_SHADER, fragmentShaderSource);

      const program = gl.createProgram();
      if (!program) throw new Error('Failed to create program');
      gl.attachShader(program, vertexShader);
      gl.attachShader(program, fragmentShader);
      gl.linkProgram(program);

      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const info = gl.getProgramInfoLog(program);
        throw new Error(`Failed to link program: ${info ?? 'unknown error'}`);
      }

      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);

      const positionBuffer = gl.createBuffer();
      const texCoordBuffer = gl.createBuffer();
      const texture = gl.createTexture();

      if (!positionBuffer || !texCoordBuffer || !texture) {
        throw new Error('Failed to allocate WebGL buffers');
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([
          -1, -1,
          1, -1,
          -1, 1,
          1, 1,
        ]),
        gl.STATIC_DRAW,
      );

      gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([
          0, 1,
          1, 1,
          0, 0,
          1, 0,
        ]),
        gl.STATIC_DRAW,
      );

      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      const positionLocation = gl.getAttribLocation(program, 'a_position');
      const texCoordLocation = gl.getAttribLocation(program, 'a_texCoord');
      const textureLocation = gl.getUniformLocation(program, 'u_texture');
      const scaleLocation = gl.getUniformLocation(program, 'u_scale');
      const grayscaleLocation = gl.getUniformLocation(program, 'u_grayscale');

      if (positionLocation < 0 || texCoordLocation < 0) {
        throw new Error('Failed to get WebGL attribute locations');
      }

      webglResourcesRef.current = {
        gl,
        program,
        positionBuffer,
        texCoordBuffer,
        texture,
        attributes: {
          position: positionLocation,
          texCoord: texCoordLocation,
        },
        uniforms: {
          texture: textureLocation,
          scale: scaleLocation,
          grayscale: grayscaleLocation,
        },
      };

      gl.useProgram(program);
      if (textureLocation) gl.uniform1i(textureLocation, 0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        1,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 255]),
      );

      setIsWebglReady(true);
      renderWebglFrame();
    } catch (error) {
      console.error('[webgl] init failed', error);
      setIsWebglSupported(false);
      cleanupWebglResources();
    }
  }, [cleanupWebglResources, renderWebglFrame, videoRef, videoUrl]);

  useEffect(() => {
    if (!videoUrl) {
      cleanupWebglResources();
      return undefined;
    }

    initWebgl();

    return () => {
      cleanupWebglResources();
    };
  }, [cleanupWebglResources, initWebgl, videoUrl]);

  useEffect(() => {
    if (!isWebglReady) return undefined;

    const handleResize = () => {
      renderWebglFrame();
    };

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(handleResize);
      if (webglContainerRef.current) observer.observe(webglContainerRef.current);
    }
    window.addEventListener('resize', handleResize);

    handleResize();

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, [isWebglReady, renderWebglFrame]);

  useEffect(() => {
    if (!isWebglReady) return undefined;
    const videoElement = videoRef.current;
    if (!videoElement) return undefined;

    const handlePlay = () => scheduleWebglRenderLoop();
    const handlePause = () => {
      renderWebglFrame();
      stopWebglRenderLoop();
    };
    const handleEnded = () => {
      renderWebglFrame();
      stopWebglRenderLoop();
    };
    const handleLoaded = () => renderWebglFrame();
    const handleSeeking = () => renderWebglFrame();
    const handleSeeked = () => renderWebglFrame();

    videoElement.addEventListener('play', handlePlay);
    videoElement.addEventListener('pause', handlePause);
    videoElement.addEventListener('ended', handleEnded);
    videoElement.addEventListener('loadeddata', handleLoaded);
    videoElement.addEventListener('loadedmetadata', handleLoaded);
    videoElement.addEventListener('seeking', handleSeeking);
    videoElement.addEventListener('seeked', handleSeeked);

    if (!videoElement.paused && !videoElement.ended) {
      scheduleWebglRenderLoop();
    } else {
      renderWebglFrame();
    }

    return () => {
      stopWebglRenderLoop();
      videoElement.removeEventListener('play', handlePlay);
      videoElement.removeEventListener('pause', handlePause);
      videoElement.removeEventListener('ended', handleEnded);
      videoElement.removeEventListener('loadeddata', handleLoaded);
      videoElement.removeEventListener('loadedmetadata', handleLoaded);
      videoElement.removeEventListener('seeking', handleSeeking);
      videoElement.removeEventListener('seeked', handleSeeked);
    };
  }, [
    isWebglReady,
    renderWebglFrame,
    scheduleWebglRenderLoop,
    stopWebglRenderLoop,
    videoRef,
    videoUrl,
  ]);

  useEffect(() => {
    if (!isWebglReady) return;
    renderWebglFrame();
  }, [isGrayscale, isWebglReady, renderWebglFrame]);

  const handleGrayscaleChange = useCallback((next: boolean) => {
    setIsGrayscale(next);
  }, []);

  return {
    isWebglSupported,
    isWebglReady,
    isGrayscale,
    handleGrayscaleChange,
    webglCanvasRef,
    webglContainerRef,
  } as const;
}
