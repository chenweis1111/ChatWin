/**
 * 鼠标轨迹算法模块（纯函数，无外部依赖）
 *
 * 由 main 进程和 Helper 进程共同引用：
 * - main 进程：通过 vite 编译时 import
 * - Helper 进程：运行时 require('./mouse-trajectory')
 *
 * 职责：生成坐标序列和延迟数据，不调用 robotjs 或任何 I/O。
 */

'use strict'

/**
 * 生成不规律延迟（Box-Muller 正态分布 + 随机停顿/加速）
 * @param {number} baseDelay 基础延迟（ms）
 * @returns {number} 实际延迟（ms，最小 5）
 */
function generateIrregularDelay(baseDelay) {
  const u1 = Math.random()
  const u2 = Math.random()
  const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)

  // 正态分布：均值 baseDelay，标准差 baseDelay * 0.4
  const normalDelay = baseDelay + z0 * baseDelay * 0.4

  // 10% 概率出现较长的停顿（模拟人类查看内容）
  if (Math.random() < 0.1) {
    const pauseMultiplier = 2 + Math.random() * 3
    return Math.max(10, normalDelay * pauseMultiplier)
  }

  // 5% 概率出现很短的快速移动
  if (Math.random() < 0.05) {
    return Math.max(5, normalDelay * 0.3)
  }

  return Math.max(5, normalDelay)
}

/**
 * ease-in-out 缓动函数
 * @param {number} t 进度 [0, 1]
 * @returns {number} 缓动后的进度
 */
function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
}

/**
 * 生成贝塞尔曲线鼠标移动路径
 *
 * @param {number} startX 起点 X
 * @param {number} startY 起点 Y
 * @param {number} targetX 终点 X
 * @param {number} targetY 终点 Y
 * @param {object} [opts]
 * @param {number} [opts.minSteps=5] 最小步数
 * @param {number} [opts.maxSteps=15] 最大步数
 * @param {number} [opts.baseDelay=2] 基础延迟 ms
 * @returns {{ points: Array<{x: number, y: number, delay: number}>, finalX: number, finalY: number }}
 */
function generateBezierPath(startX, startY, targetX, targetY, opts) {
  const { minSteps = 5, maxSteps = 15, baseDelay = 10 } = opts || {}

  const dx = targetX - startX
  const dy = targetY - startY
  const distance = Math.sqrt(dx * dx + dy * dy)

  // 距离太小，直接跳到终点
  if (distance < 1) {
    return { points: [], finalX: targetX, finalY: targetY }
  }

  // 根据距离决定步数
  const steps = Math.min(
    maxSteps,
    Math.max(minSteps, Math.floor(distance / 40) + Math.floor(Math.random() * 3))
  )

  // 生成贝塞尔曲线控制点 (Cubic Bezier)
  const ctrl1X = startX + dx * Math.random() * 0.5 + (Math.random() - 0.5) * distance * 0.2
  const ctrl1Y = startY + dy * Math.random() * 0.5 + (Math.random() - 0.5) * distance * 0.2
  const ctrl2X =
    startX + dx * (0.5 + Math.random() * 0.5) + (Math.random() - 0.5) * distance * 0.2
  const ctrl2Y =
    startY + dy * (0.5 + Math.random() * 0.5) + (Math.random() - 0.5) * distance * 0.2

  const points = []

  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const easedT = easeInOut(t)

    const invT = 1 - easedT
    const x =
      Math.pow(invT, 3) * startX +
      3 * Math.pow(invT, 2) * easedT * ctrl1X +
      3 * invT * Math.pow(easedT, 2) * ctrl2X +
      Math.pow(easedT, 3) * targetX
    const y =
      Math.pow(invT, 3) * startY +
      3 * Math.pow(invT, 2) * easedT * ctrl1Y +
      3 * invT * Math.pow(easedT, 2) * ctrl2Y +
      Math.pow(easedT, 3) * targetY

    // 随机微小抖动
    const jitterX = (Math.random() - 0.5) * 1.5
    const jitterY = (Math.random() - 0.5) * 1.5

    const delay = generateIrregularDelay(baseDelay)

    points.push({
      x: Math.round(x + jitterX),
      y: Math.round(y + jitterY),
      delay: Math.round(delay)
    })
  }

  return { points, finalX: targetX, finalY: targetY }
}

/**
 * 生成不规律滚动步长序列
 *
 * @param {number} distance 总滚动距离（滚动单位，正数向下，负数向上）
 * @param {object} [opts]
 * @param {number} [opts.minSteps=8]
 * @param {number} [opts.maxSteps=20]
 * @param {number} [opts.baseDelay=15]
 * @param {number} [opts.directionMultiplier=1] 方向校准系数
 * @returns {Array<{scrollY: number, delay: number, microMove: boolean}>}
 */
function generateScrollSequence(distance, opts) {
  const { minSteps = 8, maxSteps = 20, baseDelay = 15, directionMultiplier = 1 } = opts || {}

  const absDistance = Math.abs(distance)
  const stepCount = Math.min(
    maxSteps,
    Math.max(minSteps, Math.floor(absDistance / 10) + Math.floor(Math.random() * 5))
  )

  // 将总距离分成多步，每步距离随机化
  const stepDistances = []
  let remaining = absDistance

  for (let i = 0; i < stepCount - 1; i++) {
    const progress = i / stepCount
    const variance = 0.3 + progress * 0.4
    const stepSize = (remaining / (stepCount - i)) * (1 + (Math.random() - 0.5) * variance)
    const actualStep = Math.max(1, Math.floor(stepSize))
    stepDistances.push(actualStep)
    remaining -= actualStep
  }
  stepDistances.push(Math.max(1, remaining))

  // 打乱步长顺序
  for (let i = stepDistances.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[stepDistances[i], stepDistances[j]] = [stepDistances[j], stepDistances[i]]
  }

  const direction = distance > 0 ? 1 : -1
  const sequence = []

  for (let i = 0; i < stepDistances.length; i++) {
    const scrollY = stepDistances[i] * direction * directionMultiplier
    const delay = generateIrregularDelay(baseDelay)
    const microMove = Math.random() < 0.3 // 30% 概率微移

    // 偶尔加入较长停顿
    let extraPause = 0
    if (i < stepDistances.length - 1 && Math.random() < 0.15) {
      extraPause = Math.round(50 + Math.random() * 100)
    }

    sequence.push({
      scrollY,
      delay: Math.round(delay) + extraPause,
      microMove
    })
  }

  return sequence
}

module.exports = {
  generateBezierPath,
  generateScrollSequence,
  generateIrregularDelay,
  easeInOut
}
