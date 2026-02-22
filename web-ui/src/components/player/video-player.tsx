import mpegts from "@rtp2httpd/mpegts.js";
import { Play } from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { usePlayerTranslation } from "../../hooks/use-player-translation";
import type { Locale } from "../../lib/locale";
import { cn } from "../../lib/utils";
import type { Channel, EPGProgram } from "../../types/player";
import { PlayerControls } from "./player-controls";

interface VideoPlayerProps {
	channel: Channel | null;
	segments: mpegts.MediaSegment[];
	liveSync: boolean;
	onError?: (error: string) => void;
	locale: Locale;
	currentProgram?: EPGProgram | null;
	onSeek?: (seekTime: Date) => void;
	streamStartTime: Date;
	currentVideoTime: number;
	onCurrentVideoTimeChange: (time: number) => void;
	onChannelNavigate?: (target: "prev" | "next" | number) => void;
	showSidebar?: boolean;
	onToggleSidebar?: () => void;
	onFullscreenToggle?: () => void;
	force16x9?: boolean;
	activeSourceIndex?: number;
	onSourceChange?: (index: number) => void;
}

const MAX_RETRIES = 3;

export function VideoPlayer({
	channel,
	segments,
	onError,
	locale,
	liveSync,
	currentProgram = null,
	onSeek,
	streamStartTime,
	currentVideoTime,
	onCurrentVideoTimeChange,
	onChannelNavigate,
	showSidebar = true,
	onToggleSidebar,
	onFullscreenToggle,
	force16x9 = true,
	activeSourceIndex = 0,
	onSourceChange,
}: VideoPlayerProps) {
	const t = usePlayerTranslation(locale);

	const videoRef = useRef<HTMLVideoElement>(null);
	const playerRef = useRef<mpegts.Player | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [showLoading, setShowLoading] = useState(false);
	const loadingTimeoutRef = useRef<number>(0);
	const [isLive, setIsLive] = useState(true);
	const [error, setError] = useState<string | null>(() => (mpegts.isSupported() ? null : t("mseNotSupported")));
	const [volume, setVolume] = useState(1);
	const [isMuted, setIsMuted] = useState(false);
	const [isPlaying, setIsPlaying] = useState(false);
	const [needsUserInteraction, setNeedsUserInteraction] = useState(false);
	const [showControls, setShowControls] = useState(true);
	const [isPiP, setIsPiP] = useState(false);
	const hideControlsTimeoutRef = useRef<number>(0);
	const [retryCount, setRetryCount] = useState(0);
	const [retryBaseline, setRetryBaseline] = useState(0);
	const [isRetrySeek, setIsRetrySeek] = useState(false);
	const stablePlaybackTimeoutRef = useRef<number>(0);

	// Digit input state
	const [digitBuffer, setDigitBuffer] = useState("");
	const digitTimeoutRef = useRef<number>(0);

	// Debounce loading indicator to prevent flickering on fast loads
	useEffect(() => {
		if (isLoading) {
			// Show loading indicator after 500ms delay
			loadingTimeoutRef.current = window.setTimeout(() => {
				setShowLoading(true);
			}, 500);
		} else {
			// Immediately hide loading indicator
			// eslint-disable-next-line react-hooks/set-state-in-effect
			setShowLoading(false);
		}

		return () => {
			if (loadingTimeoutRef.current) {
				window.clearTimeout(loadingTimeoutRef.current);
				loadingTimeoutRef.current = 0;
			}
		};
	}, [isLoading]);

	const handleSeek = useCallback(
		(seekTime: Date) => {
			if (playerRef.current && seekTime.getTime() >= streamStartTime.getTime()) {
				const seekSeconds = (seekTime.getTime() - streamStartTime.getTime()) / 1000;

				// Check if seekSeconds is within buffered ranges
				const buffered = playerRef.current.buffered;
				let isBuffered = false;

				for (let i = 0; i < buffered.length; i++) {
					const start = buffered.start(i);
					const end = buffered.end(i);

					if (seekSeconds >= start && seekSeconds <= end) {
						isBuffered = true;
						break;
					}
				}

				if (isBuffered) {
					// Seek within buffered range
					playerRef.current.currentTime = seekSeconds;
					playerRef.current.play(); // resume if paused
					return;
				}
			}
			// If not buffered, call onSeek callback
			onSeek?.(seekTime);
		},
		[onSeek, streamStartTime],
	);

	const togglePlayPause = useCallback(() => {
		if (playerRef.current && videoRef.current) {
			if (videoRef.current.paused) {
				playerRef.current.play();
				setNeedsUserInteraction(false);
			} else {
				playerRef.current.pause();
			}
		}
	}, []);

	const resetControlsTimer = useCallback(() => {
		if (hideControlsTimeoutRef.current) {
			window.clearTimeout(hideControlsTimeoutRef.current);
		}
		hideControlsTimeoutRef.current = window.setTimeout(() => {
			setShowControls(false);
		}, 3000);
	}, []);

	const showControlsImmediately = useCallback(() => {
		setShowControls(true);
		resetControlsTimer();
	}, [resetControlsTimer]);

	const hideControlsImmediately = useCallback(() => {
		if (hideControlsTimeoutRef.current) {
			window.clearTimeout(hideControlsTimeoutRef.current);
			hideControlsTimeoutRef.current = 0;
		}
		setShowControls(false);
	}, []);

	// Start auto-hide timer on mount
	useEffect(() => {
		resetControlsTimer();
		return () => {
			if (hideControlsTimeoutRef.current) {
				window.clearTimeout(hideControlsTimeoutRef.current);
			}
		};
	}, [resetControlsTimer]);

	const handlePlayerError = useEffectEvent((errorType: string, errorDetail: string, errorInfo: { msg?: string }) => {
		console.error("Player error:", errorType, errorDetail, errorInfo);

		let errorMessage = t("playbackError");
		let decodingErrorRetry = false;

		if (errorType === mpegts.ErrorTypes.MEDIA_ERROR) {
			if (
				errorDetail === mpegts.ErrorDetails.MEDIA_FORMAT_UNSUPPORTED ||
				errorDetail === mpegts.ErrorDetails.MEDIA_CODEC_UNSUPPORTED ||
				errorDetail === mpegts.ErrorDetails.MEDIA_FORMAT_ERROR
			) {
				errorMessage = t("codecError");
			} else if (errorDetail === mpegts.ErrorDetails.MEDIA_MSE_ERROR) {
				errorMessage = `${t("mediaError")}: ${errorInfo?.msg}`;
				if (errorInfo?.msg?.includes("HTMLMediaElement.error")) {
					if (videoRef.current?.error?.message?.includes("PIPELINE_ERROR_DECODE")) {
						// Decoding error, may be transient (upstream packet loss / transmit pressure), can infinite retry
						decodingErrorRetry = true;
					} else {
						errorMessage += `${t("mediaError")}: ${videoRef.current?.error?.message}`;
					}
				}
			} else {
				errorMessage = `${t("mediaError")}: ${errorDetail}`;
			}
		} else if (errorType === mpegts.ErrorTypes.NETWORK_ERROR) {
			errorMessage = `${t("networkError")}: ${errorDetail}`;
		}

		// Check if we should retry
		if (retryCount < retryBaseline + MAX_RETRIES) {
			setRetryCount(retryCount + 1);
			if (!decodingErrorRetry) {
				console.log(`Retrying playback (attempt ${retryCount + 1 - retryBaseline}/${MAX_RETRIES})...`);
			} else {
				setRetryBaseline(retryBaseline + 1);
				console.log(`Retrying playback due to decoding error...`);
			}
			// Seek to current playback position so parent rebuilds segments from here
			setIsRetrySeek(true);
			if (onSeek) {
				if (liveSync) {
					// Live mode: seek to now
					onSeek(new Date());
				} else {
					// Catchup mode: seek to current position
					onSeek(new Date(streamStartTime.getTime() + currentVideoTime * 1000));
				}
			}
			return;
		}

		// Max retries reached, try fallback to next source
		if (channel && onSourceChange && activeSourceIndex + 1 < channel.sources.length) {
			console.log("Falling back to next source...");
			onSourceChange(activeSourceIndex + 1);
			return;
		}

		// No more sources to try, show error
		setError(errorMessage);
		onError?.(errorMessage);
		setIsLoading(false);
	});

	const [prevSegments, setPrevSegments] = useState(segments);
	if (segments !== prevSegments) {
		setPrevSegments(segments);
		if (isRetrySeek) {
			// Segments changed due to retry seek, preserve retry state
			setIsRetrySeek(false);
		} else {
			// Segments changed due to user action (channel switch, manual seek, etc.)
			setRetryCount(0);
			setRetryBaseline(0);
		}
	}

	// Load video stream
	useEffect(() => {
		if (!segments.length || !videoRef.current || !mpegts.isSupported()) return;

		console.log("Player loading...");

		// Clear stable playback timer when loading new stream
		if (stablePlaybackTimeoutRef.current) {
			window.clearTimeout(stablePlaybackTimeoutRef.current);
			stablePlaybackTimeoutRef.current = 0;
		}

		// eslint-disable-next-line react-hooks/set-state-in-effect
		showControlsImmediately();
		setIsLoading(true);
		setError(null);
		setIsPlaying(false);
		setNeedsUserInteraction(false);

		try {
			const player = mpegts.createPlayer(
				{
					type: "mpegts",
					segments,
				},
				{
					enableWorker: true,
					isLive: true,
					enableStashBuffer: false,
					liveSync,
				},
			);

			playerRef.current = player;
			player.attachMediaElement(videoRef.current);

			player.on(mpegts.Events.ERROR, handlePlayerError);

			player.load();

			const playPromise = player.play();
			if (playPromise) {
				playPromise
					.catch((err: Error) => {
						if (err.name === "NotAllowedError" || err.message.includes("user didn't interact")) {
							setNeedsUserInteraction(true);
						}
					})
					.finally(() => {
						setIsLoading(false);
					});
			}
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : t("failedToPlay");
			setError(errorMsg);
			onError?.(errorMsg);
			setIsLoading(false);
		}

		return () => {
			if (playerRef.current) {
				playerRef.current.destroy();
				playerRef.current = null;
			}
		};
	}, [segments, liveSync, onError, showControlsImmediately, t]);

	const handleVideoCanPlay = useEffectEvent(() => {
		setIsLoading(false);
		setIsPlaying(true);
	});

	const handleVideoWaiting = useEffectEvent(() => {
		setIsLoading(true);
		// Clear stable playback timer when buffering
		if (stablePlaybackTimeoutRef.current) {
			window.clearTimeout(stablePlaybackTimeoutRef.current);
			stablePlaybackTimeoutRef.current = 0;
		}
	});

	const handleVideoVolumeChange = useEffectEvent(() => {
		const video = videoRef.current;
		if (!video) return;
		setVolume(video.volume);
		setIsMuted(video.muted);
	});

	const handleVideoPlaying = useEffectEvent(() => {
		setIsLoading(false);
		setIsPlaying(true);

		// Start/restart stable playback timer
		if (stablePlaybackTimeoutRef.current) {
			window.clearTimeout(stablePlaybackTimeoutRef.current);
		}

		// Reset retry count after 30 seconds of stable playback
		stablePlaybackTimeoutRef.current = window.setTimeout(() => {
			if (retryCount > retryBaseline) {
				console.log(`Resetting accepted retry count after stable playback`);
				setRetryBaseline(retryCount);
			}
		}, 30000);
	});

	const handleVideoPause = useEffectEvent(() => {
		setIsPlaying(false);
		setIsLive(false);
		// Clear stable playback timer when paused
		if (stablePlaybackTimeoutRef.current) {
			window.clearTimeout(stablePlaybackTimeoutRef.current);
			stablePlaybackTimeoutRef.current = 0;
		}
	});

	const handleVideoTimeUpdate = useEffectEvent(() => {
		const video = videoRef.current;
		if (!video) return;
		if (video.currentTime < currentVideoTime || video.currentTime - currentVideoTime >= 1) {
			onCurrentVideoTimeChange(video.currentTime);
			setIsLive(streamStartTime.getTime() + video.currentTime * 1000 >= Date.now() - 3000);
		}
	});

	const handleVideoEnded = useEffectEvent(() => {
		if (onSeek && playerRef.current?.duration) {
			const seekTime = new Date(streamStartTime.getTime() + playerRef.current.duration * 1000);
			onSeek(seekTime);
		}
	});

	const handleVideoEnterPiP = useEffectEvent(() => {
		setIsPiP(true);
	});

	const handleVideoLeavePiP = useEffectEvent(() => {
		setIsPiP(false);
	});

	const handleKeyDown = useEffectEvent((e: KeyboardEvent) => {
		// Ignore if user is typing in an input field
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
			return;
		}

		// Check if it's a number key (0-9)
		const isNumberKey = /^[0-9]$/.test(e.key);

		// If it's a number key, append to buffer
		if (isNumberKey) {
			e.preventDefault();
			showControlsImmediately();

			// Clear existing timeout
			if (digitTimeoutRef.current) {
				window.clearTimeout(digitTimeoutRef.current);
			}

			// Set new timeout to confirm selection
			const newBuffer = digitBuffer + e.key;
			digitTimeoutRef.current = window.setTimeout(() => {
				onChannelNavigate?.(parseInt(newBuffer, 10));
				setDigitBuffer("");
				digitTimeoutRef.current = 0;
			}, 1000); // 1000ms delay
			setDigitBuffer(newBuffer);
			return;
		}

		switch (e.key) {
			case "Enter":
				e.preventDefault();
				if (digitBuffer) {
					if (digitTimeoutRef.current) {
						window.clearTimeout(digitTimeoutRef.current);
						digitTimeoutRef.current = 0;
					}
					onChannelNavigate?.(parseInt(digitBuffer, 10));
					setDigitBuffer("");
				} else {
					onToggleSidebar?.();
				}
				break;

			case "Escape":
				e.preventDefault();
				// Blur any focused element
				if (document.activeElement && document.activeElement !== document.body) {
					(document.activeElement as HTMLElement).blur();
				} else if (digitBuffer) {
					setDigitBuffer("");
					if (digitTimeoutRef.current) {
						window.clearTimeout(digitTimeoutRef.current);
						digitTimeoutRef.current = 0;
					}
				} else if (showControls) {
					hideControlsImmediately();
				} else {
					showControlsImmediately();
				}
				break;

			case "ArrowUp":
			case "PageDown":
			case "ChannelDown":
				e.preventDefault();
				// Previous channel
				onChannelNavigate?.("prev");
				break;

			case "ArrowDown":
			case "PageUp":
			case "ChannelUp":
				e.preventDefault();
				// Next channel
				onChannelNavigate?.("next");
				break;

			case "ArrowLeft": {
				e.preventDefault();
				// Seek backward 5 seconds
				const currentAbsoluteTime = new Date(streamStartTime.getTime() + currentVideoTime * 1000);
				const newSeekTime = new Date(currentAbsoluteTime.getTime() - 5000);
				handleSeek(newSeekTime);
				break;
			}

			case "ArrowRight": {
				e.preventDefault();
				// Seek forward 5 seconds
				const currentAbsoluteTime = new Date(streamStartTime.getTime() + currentVideoTime * 1000);
				const newSeekTime = new Date(currentAbsoluteTime.getTime() + 5000);
				handleSeek(newSeekTime);
				break;
			}

			case " ": // Space
				e.preventDefault();
				togglePlayPause();
				break;

			case "m":
			case "M":
				e.preventDefault();
				// Toggle mute
				if (playerRef.current) {
					playerRef.current.muted = !playerRef.current.muted;
				}
				break;

			case "f":
			case "F":
				e.preventDefault();
				// Toggle fullscreen
				onFullscreenToggle?.();
				break;

			case "s":
			case "S":
			case "BrowserFavorites":
				e.preventDefault();
				// Toggle sidebar
				onToggleSidebar?.();
				break;
		}
	});

	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;

		video.addEventListener("canplay", handleVideoCanPlay);
		video.addEventListener("waiting", handleVideoWaiting);
		video.addEventListener("volumechange", handleVideoVolumeChange);
		video.addEventListener("playing", handleVideoPlaying);
		video.addEventListener("pause", handleVideoPause);
		video.addEventListener("timeupdate", handleVideoTimeUpdate);
		video.addEventListener("ended", handleVideoEnded);
		video.addEventListener("enterpictureinpicture", handleVideoEnterPiP);
		video.addEventListener("leavepictureinpicture", handleVideoLeavePiP);
		window.addEventListener("keydown", handleKeyDown);

		return () => {
			video.removeEventListener("canplay", handleVideoCanPlay);
			video.removeEventListener("waiting", handleVideoWaiting);
			video.removeEventListener("volumechange", handleVideoVolumeChange);
			video.removeEventListener("playing", handleVideoPlaying);
			video.removeEventListener("pause", handleVideoPause);
			video.removeEventListener("timeupdate", handleVideoTimeUpdate);
			video.removeEventListener("ended", handleVideoEnded);
			video.removeEventListener("enterpictureinpicture", handleVideoEnterPiP);
			video.removeEventListener("leavepictureinpicture", handleVideoLeavePiP);
			window.removeEventListener("keydown", handleKeyDown);

			if (stablePlaybackTimeoutRef.current) {
				window.clearTimeout(stablePlaybackTimeoutRef.current);
				stablePlaybackTimeoutRef.current = 0;
			}
			if (digitTimeoutRef.current) {
				window.clearTimeout(digitTimeoutRef.current);
				digitTimeoutRef.current = 0;
			}
		};
	}, []);

	// Handle video click/tap - toggle controls
	const handleVideoClick = useCallback(() => {
		if (showControls) {
			hideControlsImmediately();
		} else {
			// Show controls and start auto-hide timer
			showControlsImmediately();
		}
	}, [showControls, hideControlsImmediately, showControlsImmediately]);

	const handleMuteToggle = useCallback(() => {
		if (playerRef.current) {
			playerRef.current.muted = !playerRef.current.muted;
		}
	}, []);

	const handleVolumeChange = useCallback((newVolume: number) => {
		if (playerRef.current) {
			playerRef.current.volume = newVolume;
		}
	}, []);

	const handleFullscreen = useCallback(() => {
		// Check if it's iOS
		const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

		if (isIOS && videoRef.current) {
			// iOS: Use video element's webkit fullscreen API
			const video = videoRef.current as HTMLVideoElement & {
				webkitEnterFullscreen?: () => void;
				webkitRequestFullscreen?: () => void;
			};
			if (video.webkitEnterFullscreen) {
				video.webkitEnterFullscreen();
			} else if (video.webkitRequestFullscreen) {
				video.webkitRequestFullscreen();
			}
		} else if (onFullscreenToggle) {
			// Desktop/Android: Use container fullscreen
			onFullscreenToggle();
		}
	}, [onFullscreenToggle]);

	const handlePiPToggle = useCallback(async () => {
		if (!videoRef.current) return;

		try {
			if (document.pictureInPictureElement) {
				await document.exitPictureInPicture();
			} else {
				await videoRef.current.requestPictureInPicture();
			}
		} catch (err) {
			console.error("Picture-in-Picture error:", err);
		}
	}, []);

	const handleUserClick = () => {
		if (needsUserInteraction && playerRef.current) {
			setNeedsUserInteraction(false);
			setIsPlaying(true);
			playerRef.current.play()?.catch((err: Error) => {
				console.error("Play error after user interaction:", err);
				setError(`${t("failedToPlay")}: ${err.message}`);
				onError?.(`${t("failedToPlay")}: ${err.message}`);
			});
		}
	};

	return (
		<div
			role="application"
			className="relative w-full bg-black md:h-full pt-[env(safe-area-inset-top)]"
			onMouseMove={showControlsImmediately}
			onMouseLeave={hideControlsImmediately}
		>
			{/* Mobile: 16:9 aspect ratio container, Desktop: full height */}
			<div
				className={cn(
					"video-container relative w-full aspect-video md:aspect-auto md:h-full flex items-center justify-center",
					!showControls && "cursor-none",
				)}
			>
				{/* biome-ignore lint/a11y/useMediaCaption: live streaming video has no caption tracks */}
				<video
					ref={videoRef}
					className={cn("max-w-full max-h-full", force16x9 ? "object-fill aspect-video" : "w-full h-full")}
					playsInline
					webkit-playsinline="true"
					x5-playsinline="true"
					onClick={handleVideoClick}
				/>

				{showLoading && (
					<div className="absolute top-4 left-4 md:top-8 md:left-8 flex items-center gap-2 md:gap-3 rounded-lg bg-white/10 ring-1 ring-white/20 backdrop-blur-sm px-3 py-2 md:px-4 md:py-3">
						<div className="relative h-4 w-4 md:h-5 md:w-5">
							<div className="absolute inset-0 rounded-full border-2 border-white/30" />
							<div className="absolute inset-0 rounded-full border-2 border-white border-t-transparent animate-spin" />
						</div>
						<span className="text-xs md:text-sm text-white font-medium">
							{channel &&
								channel.sources.length > 1 &&
								`[${channel.sources[activeSourceIndex]?.label || `${t("source")} ${activeSourceIndex + 1}`}] `}
							{t("loadingVideo")}
							{retryCount - retryBaseline > 0 && ` (${retryCount - retryBaseline}/${MAX_RETRIES})`}
						</span>
					</div>
				)}

				{/* Channel Info and Controls */}
				{channel && (
					<div
						className={cn(
							"absolute top-4 right-4 md:top-8 md:right-8 flex flex-col gap-2 md:gap-3 items-end transition-opacity duration-300",
							showControls ? "opacity-100" : "opacity-0",
						)}
					>
						<div className="flex flex-col gap-1.5 md:gap-2 px-2 py-1.5 md:px-3 md:py-2 items-center justify-center overflow-hidden rounded-lg bg-white/10 ring-1 ring-white/20 backdrop-blur-sm max-w-[calc(100vw-2rem)] md:max-w-none">
							{/* Logo Banner */}
							{channel.logo && (
								<img
									src={channel.logo}
									alt={channel.name}
									referrerPolicy="no-referrer"
									className="h-8 w-20 md:h-14 md:w-36 object-contain"
									onError={(e) => {
										(e.target as HTMLImageElement).style.display = "none";
									}}
								/>
							)}
							{/* Bottom Row: Channel Info & Digit Input */}
							<div className="flex items-center justify-center w-full">
								<div className="flex items-center gap-1.5 md:gap-2 min-w-0">
									<span
										className={cn(
											"rounded px-1 py-0.5 md:px-1.5 text-[10px] md:text-xs font-medium shrink-0 transition-all duration-300",
											digitBuffer
												? "bg-primary text-primary-foreground scale-110 shadow-lg ring-2 ring-primary/50"
												: "bg-white/10 text-white/60",
										)}
									>
										{digitBuffer || channel.id}
									</span>
									<h2 className="text-xs md:text-base font-bold text-white truncate">{channel.name}</h2>
									<span className="text-xs md:text-sm text-white/50 hidden sm:inline">·</span>
									<div className="text-xs md:text-sm text-white/70 truncate hidden sm:block">{channel.group}</div>
								</div>
							</div>
						</div>
					</div>
				)}

				{needsUserInteraction && (
					<button
						type="button"
						className="absolute inset-0 flex cursor-pointer items-center justify-center bg-black/80 p-4 transition-opacity hover:bg-black/85 border-none"
						onClick={handleUserClick}
					>
						<div className="flex flex-col items-center gap-4 text-white">
							<Play className="h-20 w-20 opacity-90 fill-current" />
							<div className="text-center">
								<div className="mb-2 text-2xl font-semibold">{t("clickToPlay")}</div>
								<div className="text-sm text-white/70">{t("autoplayBlocked")}</div>
							</div>
						</div>
					</button>
				)}

				{error && (
					<div className="absolute inset-0 flex items-center justify-center bg-black/90 p-4">
						<div className="max-w-md rounded-lg bg-red-500/20 p-4 text-white">
							<div className="mb-2 text-lg font-semibold">{t("playbackError")}</div>
							<div className="text-sm">{error}</div>
						</div>
					</div>
				)}

				{/* Player Controls */}
				{channel && !error && !needsUserInteraction && (
					<div
						role="toolbar"
						className={cn(
							"absolute bottom-0 left-0 right-0 transition-opacity duration-300",
							showControls ? "opacity-100" : "opacity-0 has-focus-visible:opacity-100",
						)}
						onMouseEnter={showControlsImmediately}
					>
						<PlayerControls
							channel={channel}
							currentTime={currentVideoTime}
							currentProgram={currentProgram}
							isLive={isLive}
							onSeek={handleSeek}
							locale={locale}
							seekStartTime={streamStartTime}
							isPlaying={isPlaying}
							onPlayPause={togglePlayPause}
							volume={volume}
							onVolumeChange={handleVolumeChange}
							isMuted={isMuted}
							onMuteToggle={handleMuteToggle}
							onFullscreen={handleFullscreen}
							showSidebar={showSidebar}
							onToggleSidebar={onToggleSidebar}
							isPiP={isPiP}
							onPiPToggle={handlePiPToggle}
							activeSourceIndex={activeSourceIndex}
							onSourceChange={onSourceChange}
						/>
					</div>
				)}
			</div>
		</div>
	);
}
