import { Animated, Easing, StyleSheet, View } from 'react-native';
import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import theme from '../../theme.json';

// The arrow is a curve of short, overlapping strokes that appear one after another, so it
// draws itself without an SVG library.
const SEGMENTS = 32;
const STROKE = 2.5;
const HEAD_LENGTH = 11;
const HEAD_SPREAD = 0.5; // radians either side of the shaft
const GAP = 6; // between the arrow's tip and the button
const MIN_LENGTH = 24; // closer than this, only the button glows

const DRAW_MS = 550;
const GLOW_IN_MS = 160;
const HOLD_MS = 500;
const FADE_MS = 500;

/**
 * The arrow from a tap to just below the target's frame, as stroke segments and the two arms
 * of its head. It bows downwards, so it comes up into the button from below.
 */
export function arrowGeometry(from, target) {
  const end = { x: target.x + target.width / 2, y: target.y + target.height + GAP };
  const dx = end.x - from.x;
  const dy = end.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < MIN_LENGTH) return { segments: [], head: [] };

  let nx = -dy / length;
  let ny = dx / length;
  if (ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  const bow = Math.min(length * 0.22, 80);
  const control = { x: (from.x + end.x) / 2 + nx * bow, y: (from.y + end.y) / 2 + ny * bow };
  const at = (t) => ({
    x: (1 - t) ** 2 * from.x + 2 * (1 - t) * t * control.x + t ** 2 * end.x,
    y: (1 - t) ** 2 * from.y + 2 * (1 - t) * t * control.y + t ** 2 * end.y,
  });

  const segments = [];
  for (let i = 0; i < SEGMENTS; i++) {
    const a = at(i / SEGMENTS);
    const b = at((i + 1) / SEGMENTS);
    segments.push({
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      length: Math.hypot(b.x - a.x, b.y - a.y) + 1.5, // overlap, so the joints don't show
      angle: Math.atan2(b.y - a.y, b.x - a.x),
    });
  }

  const tipAngle = Math.atan2(end.y - control.y, end.x - control.x);
  const head = [-1, 1].map((side) => {
    const angle = tipAngle + Math.PI + side * HEAD_SPREAD;
    return {
      x: end.x + (Math.cos(angle) * HEAD_LENGTH) / 2,
      y: end.y + (Math.sin(angle) * HEAD_LENGTH) / 2,
      length: HEAD_LENGTH,
      angle,
    };
  });
  return { segments, head };
}

const strokeStyle = (s, opacity) => ({
  left: s.x - s.length / 2,
  top: s.y - STROKE / 2,
  width: s.length,
  opacity,
  transform: [{ rotate: `${s.angle}rad` }],
});

/**
 * Points the way to the Cookbook when there's no model to chat with yet. `show(pageX, pageY)`
 * draws a red arrow from that point to the target (the Cookbook button), makes the button's
 * border glow red, then fades both out. Render it last so it sits above the screen.
 */
export default function CookbookHint({ ref, targetRef, radius = 8 }) {
  const containerRef = useRef(null);
  const [hint, setHint] = useState(null);

  useImperativeHandle(ref, () => ({
    show(pageX, pageY) {
      const container = containerRef.current;
      const target = targetRef.current;
      if (!container || !target) return;
      // Touches and measure() both use page coordinates; the overlay draws in its own.
      container.measure((_x, _y, _w, _h, originX, originY) => {
        target.measure((_tx, _ty, width, height, targetX, targetY) => {
          if (!width || !height) return;
          const frame = { x: targetX - originX, y: targetY - originY, width, height };
          setHint({
            frame,
            ...arrowGeometry({ x: pageX - originX, y: pageY - originY }, frame),
            // New values each time, so a tap during the animation starts a fresh one.
            draw: new Animated.Value(0),
            glow: new Animated.Value(0),
            fade: new Animated.Value(1),
          });
        });
      });
    },
  }), [targetRef]);

  useEffect(() => {
    if (!hint) return;
    const timing = (value, toValue, duration, easing) =>
      Animated.timing(value, { toValue, duration, easing, useNativeDriver: true });
    const animation = Animated.sequence([
      timing(hint.draw, 1, DRAW_MS, Easing.out(Easing.cubic)),
      timing(hint.glow, 1, GLOW_IN_MS),
      Animated.delay(HOLD_MS),
      Animated.parallel([
        timing(hint.fade, 0, FADE_MS),
        timing(hint.glow, 0, FADE_MS * 1.4),
      ]),
    ]);
    animation.start(({ finished }) => {
      if (finished) setHint(null);
    });
    return () => animation.stop();
  }, [hint]);

  const n = hint?.segments.length ?? 0;
  return (
    <View ref={containerRef} collapsable={false} style={styles.overlay}>
      {hint && (
        <>
          <Animated.View style={[StyleSheet.absoluteFill, { opacity: hint.fade }]}>
            {hint.segments.map((s, i) => (
              <Animated.View
                key={i}
                style={[styles.stroke, strokeStyle(s, hint.draw.interpolate({ inputRange: [i / n, (i + 1) / n], outputRange: [0, 1], extrapolate: 'clamp' }))]}
              />
            ))}
            {hint.head.map((s, i) => (
              <Animated.View
                key={`head-${i}`}
                style={[styles.stroke, strokeStyle(s, hint.draw.interpolate({ inputRange: [0.9, 1], outputRange: [0, 1], extrapolate: 'clamp' }))]}
              />
            ))}
          </Animated.View>
          <Animated.View
            style={[
              styles.glow,
              { left: hint.frame.x, top: hint.frame.y, width: hint.frame.width, height: hint.frame.height, borderRadius: radius, opacity: hint.glow },
            ]}
          />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    pointerEvents: 'none',
  },
  stroke: {
    position: 'absolute',
    height: STROKE,
    borderRadius: STROKE / 2,
    backgroundColor: theme.colors.red,
  },
  glow: {
    position: 'absolute',
    borderWidth: 1.5,
    borderColor: theme.colors.red,
    boxShadow: `0 0 12px 2px ${theme.colors.red}`,
  },
});
