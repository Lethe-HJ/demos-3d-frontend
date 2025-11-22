/**
 * 火焰图/时间轴性能可视化组件
 * 使用 ECharts 实现，支持缩放、滚动和悬停提示
 */

import React, { useMemo, useEffect, useRef } from 'react';
import { Card } from 'antd';
import * as echarts from 'echarts';
import type { PerformanceTrace, PerformanceEvent } from './performanceTracker';

interface FlameGraphProps {
  trace: PerformanceTrace;
}

// 类别映射和颜色
const categoryConfig: Record<
  PerformanceEvent['category'],
  { name: string; color: string; order: number }
> = {
  network: { name: '网络', color: '#4a90e2', order: 0 },
  cache: { name: '缓存', color: '#7ed321', order: 1 },
  worker: { name: 'Worker', color: '#f5a623', order: 2 },
  compute: { name: '计算', color: '#bd10e0', order: 3 },
  render: { name: '渲染', color: '#50e3c2', order: 4 },
};

const FlameGraph: React.FC<FlameGraphProps> = ({ trace }) => {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstanceRef = useRef<echarts.ECharts | null>(null);

  // 处理数据，转换为 ECharts 格式
  const chartData = useMemo(() => {
    if (!trace || trace.events.length === 0) return null;

    const totalDuration = trace.totalDuration; // 总耗时（毫秒）
    const maxTime = totalDuration / 1000; // 转换为秒

    // 按类别分组
    const eventsByCategory = trace.events.reduce((acc, event) => {
      if (!acc[event.category]) {
        acc[event.category] = [];
      }
      acc[event.category].push(event);
      return acc;
    }, {} as Record<string, PerformanceEvent[]>);

    // 为每个类别计算层级（处理重叠）
    const categoryLayers: Record<string, PerformanceEvent[][]> = {};
    
    Object.keys(eventsByCategory).forEach((category) => {
      const events = eventsByCategory[category];
      const layers: PerformanceEvent[][] = [];
      
      // 按开始时间排序
      const sortedEvents = [...events].sort((a, b) => a.startTime - b.startTime);
      
      sortedEvents.forEach((event) => {
        let placed = false;
        // 找到第一个可以放置的层
        for (let layerIndex = 0; layerIndex < layers.length; layerIndex++) {
          const layer = layers[layerIndex];
          const canPlace = layer.every((existingEvent) => {
            const existingEnd = existingEvent.startTime + existingEvent.duration;
            const eventEnd = event.startTime + event.duration;
            return existingEnd <= event.startTime || existingEvent.startTime >= eventEnd;
          });
          
          if (canPlace) {
            layer.push(event);
            placed = true;
            break;
          }
        }
        
        if (!placed) {
          layers.push([event]);
        }
      });
      
      categoryLayers[category] = layers;
    });

    // 构建 series 数据
    const series: echarts.SeriesOption[] = [];
    const yAxisData: string[] = [];
    
    // 按顺序处理每个类别
    const categories: PerformanceEvent['category'][] = ['network', 'cache', 'worker', 'compute', 'render'];
    
    categories.forEach((category) => {
      const config = categoryConfig[category];
      const layers = categoryLayers[category];
      
      if (!layers || layers.length === 0) return;
      
      // 为每个层创建一个 series
      layers.forEach((layer, layerIndex) => {
        const yIndex = yAxisData.length;
        yAxisData.push(layerIndex === 0 ? config.name : '');
        
        // 构建该层的数据点
        const data = layer.map((event) => {
          const startTime = event.startTime / 1000; // 转换为秒
          const duration = event.duration / 1000; // 转换为秒
          
          return {
            value: [startTime, yIndex, startTime + duration],
            name: event.name,
            // 保存完整事件信息用于 tooltip
            event: event,
          };
        });
        
        series.push({
          type: 'custom',
          name: layerIndex === 0 ? config.name : '',
          data: data,
          renderItem: (_params, api) => {
            const startTime = api.value(0) as number; // 开始时间（秒）
            const categoryIndex = api.value(1) as number; // y 轴索引
            const endTime = api.value(2) as number; // 结束时间（秒）
            
            const start = api.coord([startTime, categoryIndex]);
            const end = api.coord([endTime, categoryIndex]);
            const size = api.size?.([0, 1]);
            const categoryHeight = size ? (Array.isArray(size) ? size[1] : size) : 20; // 每个类别的总高度
            const barHeight = (categoryHeight * 0.7) / 2; // 条的高度（缩小为原来的1/3）
            
            const width = Math.max(end[0] - start[0], 2); // 最小宽度 2px
            
            return {
              type: 'rect',
              shape: {
                x: start[0],
                y: start[1] - barHeight / 2,
                width: width,
                height: barHeight,
              },
              style: api.style({
                fill: config.color,
                opacity: 0.85,
                stroke: 'rgba(0, 0, 0, 0.15)',
                lineWidth: 1,
              }),
              emphasis: {
                style: {
                  opacity: 1,
                  shadowBlur: 8,
                  shadowColor: 'rgba(0, 0, 0, 0.25)',
                },
              },
            };
          },
        });
      });
    });

    return {
      maxTime,
      totalDuration,
      series,
      yAxisData,
    };
  }, [trace]);

  // 初始化图表
  useEffect(() => {
    if (!chartRef.current || !chartData) return;

    // 销毁旧实例
    if (chartInstanceRef.current) {
      chartInstanceRef.current.dispose();
    }

    // 创建新实例
    const chart = echarts.init(chartRef.current);
    chartInstanceRef.current = chart;

    // 配置选项
    const option: echarts.EChartsOption = {
      title: {
        show: false,
      },
      tooltip: {
        trigger: 'item',
        formatter: (params: unknown) => {
          const p = params as { data?: { event?: PerformanceEvent } };
          if (!p?.data?.event) return '';
          
          const event = p.data.event;
          const startTime = (event.startTime / 1000).toFixed(3);
          const duration = (event.duration / 1000).toFixed(3);
          const durationMs = event.duration.toFixed(2);
          
          let html = `<div style="font-weight: bold; margin-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.3); padding-bottom: 4px;">${event.name}</div>`;
          html += `<div style="line-height: 1.6;">`;
          html += `<div>开始: ${startTime}s</div>`;
          html += `<div>持续时间: ${duration}s (${durationMs}ms)</div>`;
          
          if (event.metadata && Object.keys(event.metadata).length > 0) {
            html += `<div style="margin-top: 4px; padding-top: 4px; border-top: 1px solid rgba(255,255,255,0.3);">`;
            Object.entries(event.metadata).forEach(([k, v]) => {
              html += `<div>${k}: ${String(v)}</div>`;
            });
            html += `</div>`;
          }
          
          html += `</div>`;
          return html;
        },
        backgroundColor: 'rgba(0, 0, 0, 0.85)',
        borderColor: 'transparent',
        textStyle: {
          color: '#fff',
          fontSize: 12,
        },
        extraCssText: 'max-width: 300px;',
      },
      grid: {
        left: 100,
        right: 40,
        top: 20,
        bottom: 80,
        containLabel: false,
      },
      xAxis: {
        type: 'value',
        name: '时间 (秒)',
        nameLocation: 'middle',
        nameGap: 30,
        min: 0,
        max: chartData.maxTime,
        axisLabel: {
          formatter: (value: number) => `${value.toFixed(1)}s`,
        },
        splitLine: {
          show: true,
          lineStyle: {
            type: 'dashed',
            opacity: 0.3,
          },
        },
      },
      yAxis: {
        type: 'category',
        data: chartData.yAxisData,
        inverse: true,
        axisLabel: {
          fontSize: 11,
          fontWeight: 'bold',
          color: (value?: string | number) => {
            // 根据类别设置颜色
            const categoryName = String(value || '');
            for (const [, config] of Object.entries(categoryConfig)) {
              if (config.name === categoryName) {
                return config.color;
              }
            }
            return '#666';
          },
        },
        axisLine: {
          show: true,
          lineStyle: {
            color: '#e8e8e8',
          },
        },
        splitLine: {
          show: true,
          lineStyle: {
            color: '#f0f0f0',
          },
        },
        boundaryGap: false, // 减小类别之间的间距
      },
      dataZoom: [
        {
          type: 'slider',
          show: true,
          xAxisIndex: 0,
          start: 0,
          end: 100,
          height: 20,
          bottom: 10,
          handleSize: '80%',
          handleStyle: {
            color: '#4a90e2',
          },
          textStyle: {
            color: '#666',
            fontSize: 11,
          },
        },
        {
          type: 'inside',
          xAxisIndex: 0,
          start: 0,
          end: 100,
        },
      ],
      series: chartData.series,
      animation: false, // 禁用动画以获得更好的性能
    };

    chart.setOption(option);

    // 响应式调整
    const handleResize = () => {
      chart.resize();
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.dispose();
      chartInstanceRef.current = null;
    };
  }, [chartData]);

  if (!trace || trace.events.length === 0 || !chartData) {
    return (
      <Card title="性能时间轴（火焰图）" size="small">
        <div style={{ padding: 20, textAlign: 'center', color: '#999' }}>
          暂无性能数据
        </div>
      </Card>
    );
  }

  return (
    <Card 
      title="性能时间轴（火焰图）" 
      size="small"
      extra={
        <div style={{ fontSize: '12px', color: '#666' }}>
          总耗时: {(trace.totalDuration / 1000).toFixed(2)}s
        </div>
      }
    >
      <div style={{ position: 'relative' }}>
        {/* 图例 */}
        <div
          style={{
            marginBottom: 10,
            padding: 8,
            background: '#f5f5f5',
            borderRadius: 4,
            display: 'flex',
            flexWrap: 'wrap',
            gap: 12,
            fontSize: '12px',
          }}
        >
          {Object.entries(categoryConfig).map(([category, config]) => (
            <div key={category} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div
                style={{
                  width: 14,
                  height: 14,
                  backgroundColor: config.color,
                  borderRadius: 2,
                }}
              />
              <span>{config.name}</span>
            </div>
          ))}
        </div>

        {/* ECharts 容器 */}
        <div
          ref={chartRef}
          style={{
            width: '100%',
            height: Math.max(300, chartData.yAxisData.length * 20),
            minHeight: 300,
          }}
        />

        {/* 使用提示 */}
        <div style={{ marginTop: 10, fontSize: '11px', color: '#999', textAlign: 'center' }}>
          💡 提示: 使用底部滚动条或 Ctrl/Cmd + 滚轮缩放，鼠标悬停查看详细信息
        </div>
      </div>
    </Card>
  );
};

export default FlameGraph;
