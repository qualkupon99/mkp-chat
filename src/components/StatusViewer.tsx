import { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronLeft } from 'lucide-react';
import type { Status, Profile } from '../lib/supabase';
import { formatDistanceToNow } from 'date-fns';

type StatusWithProfile = Status & { profile: Profile };

interface StatusViewerProps {
  statuses: StatusWithProfile[];
  initialIndex: number;
  onClose: () => void;
  onStatusViewed: (statusId: string) => void;
}

export default function StatusViewer({ statuses, initialIndex, onClose, onStatusViewed }: StatusViewerProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [progress, setProgress] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const requestRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);
  const pauseTimeRef = useRef<number>(0);
  
  const DURATION = 5000; // 5 seconds per status

  const currentStatus = statuses[currentIndex];

  const handleNext = useCallback(() => {
    if (currentIndex < statuses.length - 1) {
      setCurrentIndex(prev => prev + 1);
      setProgress(0);
      startTimeRef.current = performance.now();
    } else {
      onClose();
    }
  }, [currentIndex, statuses.length, onClose]);

  const handlePrev = useCallback(() => {
    if (currentIndex > 0) {
      setCurrentIndex(prev => prev - 1);
      setProgress(0);
      startTimeRef.current = performance.now();
    }
  }, [currentIndex]);

  const animate = useCallback((time: number) => {
    if (!startTimeRef.current) startTimeRef.current = time;

    if (isPaused) {
      // Keep track of how long we are paused so we can shift the start time
      if (!pauseTimeRef.current) pauseTimeRef.current = time;
    } else {
      if (pauseTimeRef.current) {
        startTimeRef.current += (time - pauseTimeRef.current);
        pauseTimeRef.current = 0;
      }
      const elapsed = time - startTimeRef.current;
      const currentProgress = Math.min((elapsed / DURATION) * 100, 100);
      setProgress(currentProgress);

      if (currentProgress >= 100) {
        handleNext();
        return; // Don't request next frame, handleNext resets it
      }
    }
    requestRef.current = requestAnimationFrame(animate);
  }, [handleNext, isPaused]);

  useEffect(() => {
    // Reset timer when status changes
    setProgress(0);
    startTimeRef.current = performance.now();
    pauseTimeRef.current = 0;
    
    // Mark as viewed
    if (currentStatus) {
      onStatusViewed(currentStatus.id);
    }
    
    requestRef.current = requestAnimationFrame(animate);
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [currentIndex, animate, currentStatus, onStatusViewed]);

  if (!currentStatus) return null;

  return (
    <div 
      style={{
        position: 'fixed', inset: 0, zIndex: 1000, 
        backgroundColor: '#000', color: '#fff',
        display: 'flex', flexDirection: 'column'
      }}
    >
      {/* Progress Bars */}
      <div style={{ display: 'flex', gap: 4, padding: '16px 8px 8px 8px', position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10 }}>
        {statuses.map((_, idx) => (
          <div key={idx} style={{ flex: 1, height: 2, backgroundColor: 'rgba(255,255,255,0.3)', borderRadius: 2, overflow: 'hidden' }}>
            <div 
              style={{
                height: '100%',
                backgroundColor: '#fff',
                width: idx === currentIndex ? `${progress}%` : idx < currentIndex ? '100%' : '0%',
                transition: idx === currentIndex ? 'none' : 'width 0.1s linear'
              }}
            />
          </div>
        ))}
      </div>

      {/* Header */}
      <div style={{ padding: '8px', position: 'absolute', top: 24, left: 0, right: 0, zIndex: 10, display: 'flex', alignItems: 'center', gap: 12 }}>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', padding: 8 }}>
          <ChevronLeft size={28} />
        </button>
        <div className="avatar avatar-sm" style={{ border: 'none' }}>
           {currentStatus.profile?.avatar_url 
              ? <img src={currentStatus.profile.avatar_url} alt="" style={{width: '100%', height: '100%', objectFit: 'cover'}}/>
              : currentStatus.profile?.full_name?.charAt(0) || '?'}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: '0.9375rem', textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>
            {currentStatus.profile?.full_name}
          </div>
          <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.8)', textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>
            {formatDistanceToNow(new Date(currentStatus.created_at), { addSuffix: true })}
          </div>
        </div>
      </div>

      {/* Tap Zones & Content */}
      <div 
        style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}
        onMouseDown={() => setIsPaused(true)}
        onMouseUp={() => setIsPaused(false)}
        onTouchStart={() => setIsPaused(true)}
        onTouchEnd={() => setIsPaused(false)}
      >
        {/* Left Tap Zone */}
        <div onClick={handlePrev} style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '30%', zIndex: 5 }} />
        
        {/* Right Tap Zone */}
        <div onClick={handleNext} style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: '70%', zIndex: 5 }} />

        {/* Content */}
        <div style={{ padding: 24, textAlign: 'center', fontSize: '1.5rem', fontWeight: 500, lineHeight: 1.4, maxWidth: 600 }}>
          {currentStatus.content}
        </div>
      </div>
    </div>
  );
}
