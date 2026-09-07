# Janus Mobile

独立的手机端前端骨架，当前使用 mock 数据，不连接电脑端 Gateway。

## 启动

```bash
npm install
npm run start
```

也可以运行 `npm run web` 在浏览器中预览。

## 页面

- 连接电脑
- 首页
- 会话列表与 uBuddy 会话
- 任务列表
- 设置

下一阶段接入 `src/api/gateway.ts`，将 mock 数据替换为电脑端 Mobile Gateway API。
