import React from "react";
import { Breadcrumb, Layout, Menu, theme } from "antd";
import type { MenuProps } from "antd";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { headerMenuItems, sidebarMenuItems } from "./menuConfig";

const { Header, Content, Sider } = Layout;

const LayoutPage: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const {
    token: { colorBgContainer, borderRadiusLG },
  } = theme.useToken();

  const selectedKey = location.pathname === "/" ? "/" : location.pathname;

  const findSidebarParentKey = React.useCallback(
    (path: string) => {
      for (const item of sidebarMenuItems ?? []) {
        if (!item || typeof item === "string") continue;
        if ("children" in item && item.children) {
          const hasMatch = item.children.some(
            (child) =>
              child &&
              typeof child !== "string" &&
              "key" in child &&
              child.key === path
          );
          if (hasMatch) {
            return typeof item.key === "string" ? item.key : undefined;
          }
        }
      }
      return undefined;
    },
    []
  );

  const [openKeys, setOpenKeys] = React.useState<string[]>(() => {
    const parentKey = findSidebarParentKey(selectedKey);
    return parentKey ? [parentKey] : [];
  });

  React.useEffect(() => {
    const parentKey = findSidebarParentKey(selectedKey);
    setOpenKeys(parentKey ? [parentKey] : []);
  }, [findSidebarParentKey, selectedKey]);

  const handleMenuNavigate: MenuProps["onClick"] = (info) => {
    if (typeof info.key === "string" && info.key) {
      navigate(info.key);
    }
  };

  const handleSidebarOpenChange: MenuProps["onOpenChange"] = (keys) => {
    setOpenKeys(keys as string[]);
  };

  const headerSelectedKeys =
    headerMenuItems?.some(
      (item) => item && typeof item !== "string" && item.key === selectedKey
    )
      ? [selectedKey]
      : [];

  return (
    <Layout style={{ minHeight: "100%" }}>
      <Header style={{ display: "flex", alignItems: "center" }}>
        <div className="demo-logo" />
        <Menu
          theme="dark"
          mode="horizontal"
          selectedKeys={headerSelectedKeys}
          items={headerMenuItems}
          style={{ flex: 1, minWidth: 0 }}
          onClick={handleMenuNavigate}
        />
      </Header>
      <div style={{ padding: "0 48px" }}>
        <Breadcrumb style={{ margin: "16px 0" }} items={[{ title: "Home" }]} />
        <Layout
          style={{
            padding: "24px 0",
            background: colorBgContainer,
            borderRadius: borderRadiusLG,
          }}
        >
          <Sider style={{ background: colorBgContainer }} width={200}>
            <Menu
              mode="inline"
              selectedKeys={[selectedKey]}
              openKeys={openKeys}
              style={{ height: "100%" }}
              items={sidebarMenuItems}
              onClick={handleMenuNavigate}
              onOpenChange={handleSidebarOpenChange}
            />
          </Sider>
          <Content
            style={{
              padding: "0 24px",
              minHeight: 280,
              background: colorBgContainer,
              borderRadius: borderRadiusLG,
            }}
          >
            <Outlet />
          </Content>
        </Layout>
      </div>
    </Layout>
  );
};

export default LayoutPage;
