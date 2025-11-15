import React from "react";
import {
  LaptopOutlined,
  NotificationOutlined,
  UserOutlined,
} from "@ant-design/icons";
import type { MenuProps } from "antd";

export const headerMenuItems: MenuProps["items"] = [
  {
    key: "/",
    label: "首页",
  },
  {
    key: "/surface-nets",
    label: "Surface Nets",
  },
];

export const sidebarMenuItems: MenuProps["items"] = [
  {
    key: "overview",
    icon: React.createElement(UserOutlined),
    label: "概览",
    children: [
      {
        key: "/",
        label: "项目概览",
      },
    ],
  },
  {
    key: "surface-nets",
    icon: React.createElement(LaptopOutlined),
    label: "Surface Nets",
    children: [
      {
        key: "/surface-nets",
        label: "案例一",
      },
    ],
  },
  {
    key: "notifications",
    icon: React.createElement(NotificationOutlined),
    label: "消息中心",
    children: [
      {
        key: "todo",
        label: "待办提醒",
      },
    ],
  },
];

