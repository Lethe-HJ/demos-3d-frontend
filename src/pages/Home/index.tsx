import { useEffect, useRef } from 'react'

const Home = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const context = canvas.getContext('2d')
    if (!context) return

    context.fillStyle = '#7aa2f7'
    context.fillRect(0, 0, canvas.width, canvas.height)

    context.fillStyle = '#1a1b26'
    context.font = '24px sans-serif'
    context.fillText('Home Canvas', 16, 40)
  }, [])

  return (
    <div style={{ padding: 24, height: '100%' }}>
      <canvas ref={canvasRef} width={600} height={400} style={{ maxWidth: '100%' }} />
    </div>
  )
}

export default Home

