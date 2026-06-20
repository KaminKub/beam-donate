/**
 * Sound Cache Manager for TipKub
 * This implementation uses local caching to respect MyInstants server bandwidth
 * 
 * Architecture:
 * - CacheManager: Handles Cache API operations (fetch, store, retrieve)
 * - SoundPlayer: Handles audio playback with cache-first strategy
 * - Lazy Loading: Only fetches on first play trigger
 */

class SoundCacheManager {
  constructor(cacheName = 'tipkub-sounds-v1') {
    this.cacheName = cacheName;
    this.cache = null;
    this.initPromise = this._init();
  }

  async _init() {
    try {
      if ('caches' in window) {
        this.cache = await caches.open(this.cacheName);
        console.log('[SoundCache] Cache initialized:', this.cacheName);
      } else {
        console.warn('[SoundCache] Cache API not supported, falling back to direct fetch');
      }
    } catch (err) {
      console.error('[SoundCache] Failed to initialize cache:', err);
    }
  }

  async _getCacheKey(url) {
    return `sound:${url}`;
  }

  /**
   * Check if sound exists in cache
   */
  async has(url) {
    await this.initPromise;
    if (!this.cache) return false;
    
    try {
      const key = await this._getCacheKey(url);
      const cached = await this.cache.match(key);
      return !!cached;
    } catch (err) {
      console.error('[SoundCache] Error checking cache:', err);
      return false;
    }
  }

  /**
   * Get sound from cache or fetch from network
   * Returns: Blob URL for audio playback
   */
  async getSound(url) {
    await this.initPromise;
    
    // Try cache first
    if (this.cache) {
      try {
        const key = await this._getCacheKey(url);
        const cached = await this.cache.match(key);
        
        if (cached) {
          console.log('[SoundCache] Cache hit:', url);
          const blob = await cached.blob();
          return URL.createObjectURL(blob);
        }
      } catch (err) {
        console.error('[SoundCache] Cache read error:', err);
      }
    }

    // Fetch from network
    console.log('[SoundCache] Cache miss, fetching:', url);
    try {
      const response = await fetch(url, {
        mode: 'cors',
        credentials: 'omit',
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const blob = await response.blob();

      // Store in cache
      if (this.cache) {
        try {
          const key = await this._getCacheKey(url);
          const cacheResponse = new Response(blob, {
            headers: {
              'Content-Type': blob.type || 'audio/mpeg',
              'Cache-Control': 'public, max-age=31536000', // 1 year
            },
          });
          await this.cache.put(key, cacheResponse);
          console.log('[SoundCache] Cached successfully:', url);
        } catch (err) {
          console.warn('[SoundCache] Failed to cache:', err);
        }
      }

      return URL.createObjectURL(blob);
    } catch (err) {
      console.error('[SoundCache] Failed to fetch sound:', url, err);
      throw new Error(`ไม่สามารถโหลดเสียงได้: ${err.message}`);
    }
  }

  /**
   * Pre-cache multiple sounds (optional, for background loading)
   */
  async precache(urls) {
    console.log(`[SoundCache] Precaching ${urls.length} sounds...`);
    const results = await Promise.allSettled(
      urls.map(url => this.getSound(url))
    );
    
    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.length - succeeded;
    
    console.log(`[SoundCache] Precache complete: ${succeeded} succeeded, ${failed} failed`);
    return { succeeded, failed };
  }

  /**
   * Clear all cached sounds
   */
  async clear() {
    await this.initPromise;
    if (!this.cache) return;
    
    try {
      const keys = await this.cache.keys();
      for (const request of keys) {
        await this.cache.delete(request);
      }
      console.log('[SoundCache] Cache cleared');
    } catch (err) {
      console.error('[SoundCache] Failed to clear cache:', err);
    }
  }

  /**
   * Get cache statistics
   */
  async getStats() {
    await this.initPromise;
    if (!this.cache) return { count: 0, size: 0 };
    
    try {
      const keys = await this.cache.keys();
      let totalSize = 0;
      
      for (const request of keys) {
        const response = await this.cache.match(request);
        if (response) {
          const blob = await response.blob();
          totalSize += blob.size;
        }
      }
      
      return {
        count: keys.length,
        size: totalSize,
        sizeMB: (totalSize / 1024 / 1024).toFixed(2),
      };
    } catch (err) {
      console.error('[SoundCache] Failed to get stats:', err);
      return { count: 0, size: 0, sizeMB: '0' };
    }
  }
}

class SoundPlayer {
  constructor(cacheManager) {
    this.cacheManager = cacheManager;
    this.currentAudio = null;
    this.currentUrl = null;
    this.blobUrls = new Map(); // Track blob URLs for cleanup
  }

  /**
   * Play sound from URL (with caching)
   */
  async play(url, options = {}) {
    const { volume = 0.5, loop = false } = options;

    // Stop current playback
    this.stop();

    try {
      // Get cached or fetch sound
      const blobUrl = await this.cacheManager.getSound(url);
      
      // Create audio element with preload to ensure data is ready
      const audio = new Audio(blobUrl);
      audio.preload = 'auto';
      audio.volume = volume;
      audio.loop = loop;

      // Track blob URL for cleanup
      this.blobUrls.set(url, blobUrl);

      // Wait for audio to be ready before playing
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Audio load timeout'));
        }, 10000);

        audio.oncanplaythrough = () => {
          clearTimeout(timeout);
          resolve();
        };

        audio.onerror = (e) => {
          clearTimeout(timeout);
          console.error('[SoundPlayer] Audio load error:', url, e);
          reject(new Error('Audio load failed'));
        };

        // If already ready (cached blob), resolve immediately
        if (audio.readyState >= 4) {
          clearTimeout(timeout);
          resolve();
        }
      });

      // Handle playback errors
      audio.onerror = () => {
        console.error('[SoundPlayer] Audio playback error:', url);
        this.stop();
      };

      // Play
      await audio.play();
      
      this.currentAudio = audio;
      this.currentUrl = url;
      
      console.log('[SoundPlayer] Playing:', url);
      return audio;
    } catch (err) {
      console.error('[SoundPlayer] Failed to play:', url, err);
      throw err;
    }
  }

  /**
   * Pause current playback
   */
  pause() {
    if (this.currentAudio) {
      this.currentAudio.pause();
      console.log('[SoundPlayer] Paused');
    }
  }

  /**
   * Resume playback
   */
  resume() {
    if (this.currentAudio && this.currentAudio.paused) {
      this.currentAudio.play().catch(err => {
        console.error('[SoundPlayer] Resume failed:', err);
      });
    }
  }

  /**
   * Stop playback and cleanup
   */
  stop() {
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio.currentTime = 0;
      this.currentAudio = null;
      console.log('[SoundPlayer] Stopped');
    }
    this.currentUrl = null;
  }

  /**
   * Check if currently playing
   */
  isPlaying() {
    return this.currentAudio && !this.currentAudio.paused;
  }

  /**
   * Cleanup all blob URLs
   */
  cleanup() {
    this.stop();
    for (const [url, blobUrl] of this.blobUrls) {
      URL.revokeObjectURL(blobUrl);
    }
    this.blobUrls.clear();
    console.log('[SoundPlayer] Cleanup complete');
  }
}

// Export for use in dashboard.js
window.SoundCacheManager = SoundCacheManager;
window.SoundPlayer = SoundPlayer;
