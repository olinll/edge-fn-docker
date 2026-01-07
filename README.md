# Edge Function Docker 代理

本项目实现了一个腾讯云 EdgeOne 边缘函数（Edge Function）。它作为一个动态代理，根据从远程 API 获取的配置，对请求进行鉴权并将流量路由到目标服务。

## 项目结构

- `edge-functions/index.js`: 包含处理请求、与后端 API 通信以及代理流量的主要逻辑。
- `edge-functions/[[default]].js`: 入口文件，导出 `onRequest` 处理程序。
- `.edgeone/project.json`: EdgeOne 项目配置文件。

## 功能特性

- **动态路由**: 从配置的 API 端点获取目标 URL 和鉴权 Token。
- **安全代理**: 将请求转发到目标服务，并在 Cookie 中注入 `entry-token`。
- **Cookie 管理**: 处理 Cookie 的解析和序列化以维护会话状态。
- **环境配置**: 使用环境变量进行灵活配置。

## 配置

该函数依赖于以下环境变量。请确保在您的 EdgeOne 环境中设置了这些变量：

| 变量名 | 描述 |
|----------|-------------|
| `FN_ID` | 函数 ID。 |
| `FN_USERNAME` | 用于后端 API 认证的用户名。 |
| `FN_PASSWORD` | 用于后端 API 认证的密码。 |
| `FN_PORT` | 目标服务的端口号（如适用）。 |
| `FN_KEY` | 用于标识或安全的密钥。 |
| `FN_API` | 后端 API 的基础 URL（例如 `https://api.example.com`）。 |

## 工作原理

1.  **请求处理**: `onRequest` 函数拦截传入的 HTTP 请求。
2.  **获取配置**: 从环境变量中读取必要的配置信息。
3.  **后端连接**: 使用配置的凭据向 `${FN_API}/api/fn/connect` 发送 POST 请求。
4.  **目标解析**: 后端 API 返回目标 URL (`url`) 和访问令牌 (`token`)。
5.  **代理转发**:
    - 保留原始请求的 Headers。
    - 将 `entry-token` 添加到 Cookie 中。
    - 将请求转发到返回的目标 URL。
6.  **响应**: 将目标服务的响应返回给客户端。

## 开发

1.  **安装依赖**:
    ```bash
    npm install
    ```

2.  **代码逻辑**:
    核心逻辑位于 `edge-functions/index.js`。`proxy` 函数处理请求转发，`getFnUrl` 负责与后端 API 通信。

## 部署

本项目旨在部署于腾讯云 EdgeOne。请确保已安装并配置 EdgeOne CLI，或通过 EdgeOne 控制台进行部署。
