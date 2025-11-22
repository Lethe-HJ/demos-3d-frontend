/**
 * 火焰图/时间轴性能可视化组件
 * 使用 ECharts 实现，支持缩放、滚动和悬停提示
 * 适配新的性能数据格式
 */

import React, { useMemo, useEffect, useRef } from 'react';
import { Card } from 'antd';
import * as echarts from 'echarts';
import type { PerformanceSession, PerformanceRecord, ChannelGroupConfig } from './types';
import { CHANNEL_GROUPS } from './tracker';

interface FlameGraphProps {
  session: PerformanceSession;
}

const FlameGraph: React.FC<FlameGraphProps> = ({ session }) => {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstanceRef = useRef<echarts.ECharts | null>(null);

  // 处理数据，转换为 ECharts 格式
  const chartData = useMemo(() => {
    if (!session || !session.records || session.records.length === 0) return null;

    // 计算时间范围（从 Unix 时间戳转换为相对时间）
    const sessionStartTime = session.sessionStartTime;
    const sessionEndTime = session.sessionEndTime;
    const totalDuration = sessionEndTime - sessionStartTime; // 总耗时（毫秒）
    const maxTime = totalDuration / 1000; // 转换为秒

    // 按 channelGroup 和 channelIndex 分组
    const recordsByGroup: Record<string, PerformanceRecord[]> = {};
    
    session.records.forEach((record) => {
      const key = `${record.channelGroup}_${record.channelIndex}`;
      if (!recordsByGroup[key]) {
        recordsByGroup[key] = [];
      }
      recordsByGroup[key].push(record);
    });

    // 按 channelGroup 分组，每个 group 内的 channelIndex 作为行
    // channelIndex 可以是 number 或 string，需要统一处理
    const groupsMap: Record<string, Map<string, PerformanceRecord[]>> = {};
    
    session.records.forEach((record) => {
      if (!groupsMap[record.channelGroup]) {
        groupsMap[record.channelGroup] = new Map();
      }
      // 将 channelIndex 转换为字符串作为 key，确保同一 channelIndex 在同一行
      const indexKey = String(record.channelIndex);
      if (!groupsMap[record.channelGroup].has(indexKey)) {
        groupsMap[record.channelGroup].set(indexKey, []);
      }
      groupsMap[record.channelGroup].get(indexKey)!.push(record);
    });

    // 为每个行计算层级（处理重叠）
    // 同一个 channelIndex 的所有记录应该在同一行，重叠的记录放在不同层
    const channelLayers: Record<string, Map<string, PerformanceRecord[][]>> = {};
    
    Object.keys(groupsMap).forEach((groupName) => {
      channelLayers[groupName] = new Map();
      const indexMap = groupsMap[groupName];
      
      indexMap.forEach((records, indexKey) => {
        const layers: PerformanceRecord[][] = [];
        
        // 按开始时间排序
        const sortedRecords = [...records].sort((a, b) => a.startTime - b.startTime);
        
        sortedRecords.forEach((record) => {
          let placed = false;
          // 找到第一个可以放置的层（不重叠的层）
          for (let layerIndex = 0; layerIndex < layers.length; layerIndex++) {
            const layer = layers[layerIndex];
            const canPlace = layer.every((existingRecord) => {
              return (
                existingRecord.endTime <= record.startTime ||
                existingRecord.startTime >= record.endTime
              );
            });
            
            if (canPlace) {
              layer.push(record);
              placed = true;
              break;
            }
          }
          
          // 如果所有层都有重叠，创建新层
          if (!placed) {
            layers.push([record]);
          }
        });
        
        // 使用字符串 key 存储，确保同一 channelIndex 在同一行
        channelLayers[groupName].set(indexKey, layers);
      });
    });

    // 构建 series 数据
    const series: echarts.SeriesOption[] = [];
    const yAxisData: string[] = [];
    
    // 按 channelGroup 的顺序处理
    const groupOrder = Object.values(CHANNEL_GROUPS).sort((a, b) => a.order - b.order);
    
    groupOrder.forEach((groupConfig) => {
      const groupName = groupConfig.name;
      const layers = channelLayers[groupName];
      
      if (!layers || layers.size === 0) return;
      
      // 按 channelIndex 排序（支持数字和字符串）
      const sortedIndexes = Array.from(layers.keys()).sort((a, b) => {
        // 如果都是数字，按数字排序
        const numA = Number(a);
        const numB = Number(b);
        if (!isNaN(numA) && !isNaN(numB)) {
          return numA - numB;
        }
        // 否则按字符串排序
        return a.localeCompare(b);
      });
      
      sortedIndexes.forEach((indexKey) => {
        const recordLayers = layers.get(indexKey)!;
        const channelIndex = indexKey; // 保持原始值（可能是数字字符串或文本）
        
        // 为每个层创建一个 series（同一 channelIndex 的所有层在同一行）
        recordLayers.forEach((layer, layerIndex) => {
          const yIndex = yAxisData.length;
          // 只有第一层显示标签，其他层留空（同一行）
          const isNumeric = !isNaN(Number(channelIndex));
          const displayName = layerIndex === 0 
            ? `${groupConfig.displayName}${isNumeric && Number(channelIndex) !== 0 ? ` [${channelIndex}]` : !isNumeric ? ` [${channelIndex}]` : ''}`
            : '';
          yAxisData.push(displayName);
          
          // 构建该层的数据点
          const data = layer.map((record) => {
            // 转换为相对时间（秒）
            const relativeStartTime = (record.startTime - sessionStartTime) / 1000;
            const relativeEndTime = (record.endTime - sessionStartTime) / 1000;
            
            return {
              value: [relativeStartTime, yIndex, relativeEndTime],
              name: record.msg,
              // 保存完整记录信息用于 tooltip
              record: record,
            };
          });
          
          series.push({
            type: 'custom',
            name: layerIndex === 0 ? displayName || groupConfig.displayName : '',
            data: data,
            renderItem: (_params, api) => {
              const startTime = api.value(0) as number; // 开始时间（秒）
              const categoryIndex = api.value(1) as number; // y 轴索引
              const endTime = api.value(2) as number; // 结束时间（秒）
              
              const start = api.coord([startTime, categoryIndex]);
              const end = api.coord([endTime, categoryIndex]);
              const size = api.size?.([0, 1]);
              const categoryHeight = size ? (Array.isArray(size) ? size[1] : size) : 20;
              const barHeight = (categoryHeight * 0.7) / 3; // 条的高度（缩小为原来的1/3）
              
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
                  fill: groupConfig.color,
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
    });

    return {
      maxTime,
      totalDuration,
      series,
      yAxisData,
    };
  }, [session]);

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
          const p = params as { data?: { record?: PerformanceRecord } };
          if (!p?.data?.record) return '';
          
          const record = p.data.record;
          const startTime = new Date(record.startTime).toISOString();
          const endTime = new Date(record.endTime).toISOString();
          const duration = (record.endTime - record.startTime).toFixed(2);
          const durationSec = ((record.endTime - record.startTime) / 1000).toFixed(3);
          
          let html = `<div style="font-weight: bold; margin-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.3); padding-bottom: 4px;">${record.msg}</div>`;
          html += `<div style="line-height: 1.6;">`;
          html += `<div>开始: ${startTime}</div>`;
          html += `<div>结束: ${endTime}</div>`;
          html += `<div>持续时间: ${durationSec}s (${duration}ms)</div>`;
          html += `<div>行组: ${record.channelGroup}</div>`;
          html += `<div>行号: ${record.channelIndex}</div>`;
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
        left: 120,
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
          color: (value: string) => {
            // 根据行组设置颜色
            for (const groupConfig of Object.values(CHANNEL_GROUPS)) {
              if (value.includes(groupConfig.displayName)) {
                return groupConfig.color;
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
        boundaryGap: false,
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

  if (!session || !session.records || session.records.length === 0) {
    return (
      <Card title="性能时间轴（火焰图）" size="small">
        <div style={{ padding: 20, textAlign: 'center', color: '#999' }}>
          暂无性能数据
        </div>
      </Card>
    );
  }

  const totalDuration = (session.sessionEndTime - session.sessionStartTime) / 1000;

  return (
    <Card 
      title="性能时间轴（火焰图）" 
      size="small"
      extra={
        <div style={{ fontSize: '12px', color: '#666' }}>
          总耗时: {totalDuration.toFixed(2)}s
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
          {Object.values(CHANNEL_GROUPS).map((config) => (
            <div key={config.name} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div
                style={{
                  width: 14,
                  height: 14,
                  backgroundColor: config.color,
                  borderRadius: 2,
                }}
              />
              <span>{config.displayName}</span>
            </div>
          ))}
        </div>

        {/* ECharts 容器 */}
        <div
          ref={chartRef}
          style={{
            width: '100%',
            height: Math.max(300, (chartData?.yAxisData.length || 0) * 20),
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

