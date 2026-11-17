# depot-view

设计库视图重映射后的文件资料领取相关资料接收服务，面向授权来源的原件领取、解释和持久查询。

## 当前能力

可以查看 depot 文件修订和 changelist 原始事件，并按客户视图投影领取交付（DepotCourier）。

`src/reader.mjs` 提供现有单件读取契约；`src/transport.mjs` 只访问配置来源的同源地址，拒绝隐式跳转；`src/store.mjs` 保存原件摘要、解释结果和交付档案。`src/view.mjs` 按映射顺序投影视图：普通后续命中替换先前目标，`-` 排除清空， `+` 覆盖保留多个来源。`src/courier.mjs` 是 DepotCourier 本体：基于视图领取交付、跟进 changelist、视图切换重投影。`src/service.mjs` 是产品入口，`src/provider.mjs` 是独立 HTTP 联调来源，内容为无个人信息的本地样例。

DepotCourier 把 depot 修订身份（depotFile#rev）、交付路径和移动关系分开记录：条目携带修订身份与内容摘要，移动关系单独登记，不按工作区路径推增量，因此移动不会被误当成删除再新建，视图排除的旧文件也不会留在交付里。跟进 changelist 时只处理落入这份交付视图的内容，交付外文件记入 skipped。同一交付路径出现不同内容时判定为碰撞：交付停在可核对状态（status 为 collision，候选双方内容都已保存可查），不替用户挑赢家。切换视图后对同一份 depot 修订表重新投影，产生的效果全部归因于视图（cause 为 view），与供应商修改源文件（cause 为 depot）区分；每步操作追加 history 事件，可持久查询。

## 环境与运行

Node.js 22.22 至 22.x，无 npm 依赖，无外部运行服务或下载步骤。Linux、Windows 均使用以下命令；干净目录可直接运行。

```sh
npm ci --offline --ignore-scripts
npm test
npm run build
npm run demo
```

`npm run demo` 自动在本机回环端口启动来源与产品，演示完整交付生命周期：按视图领取、跟进移动与新增 changelist、跳过交付外内容、来源侧切换视图后重投影并归因、碰撞停点查询，然后关闭服务并清理临时目录。它展示当前产品能力，不模拟尚不存在的能力。演示没有固定等待、外网访问或人工操作，通常数秒结束。扩展产品后可按实际能力更新演示路径；不要以打印预先保存的结果替代运行。

直接 `npm start` 即可启动产品，默认自动在临时回环端口创建本地合成来源，产品默认监听 127.0.0.1:4102。退出产品时同步关闭自带来源。需要联调独立来源时先运行 `npm run source`，再设置 SOURCE_URL=http://127.0.0.1:4101 运行 `npm start`；显式来源不会由产品关闭。DATA_DIR 可设置资料目录，PORT 可覆盖产品监听端口。构建产物位于 dist，启动、测试与演示均不需要外部服务或下载。

## 已有接口

- GET /health：服务状态。
- POST /intakes，JSON 为 {"path":"/primary"}：按现有 reader 接收单件原件；内容解释失败不登记资料。
- GET /records：持久接收目录；同 source URL、同摘要重领返回原 id。
- GET /objects/{digest}：读取已保存的原始字节。
- POST /deliveries：按来源当前视图领取一份交付，返回含条目、排除清单与碰撞的交付档案。
- GET /deliveries：交付摘要列表；GET /deliveries/{id}：交付档案（修订表、条目、移动、碰撞、history）。
- POST /deliveries/{id}/changes，JSON 为 {"path":"/changes/11"}：跟进一个 changelist，只处理落入交付视图的内容，返回归因效果与 skipped；来源视图已漂移时在 viewStale 中提示。
- POST /deliveries/{id}/refresh：重新读取来源视图，对同一修订表重投影，效果归因于视图；视图未变为空操作。

这些是兼容接口，后续扩展可以新增业务入口，但不能把 GET 请求变为写操作。收件记录当前只包含单件 raw 对象，不代表关联资料已完整；交付档案与收件记录分开持久化。

## 来源与资料

交换范围、字段和边界见 [来源约定](docs/upstream.md)，样例资源清单可访问来源的 /catalog。`fixtures/upstream.json` 描述 HTTP 资源和阶段变体，不包含产品实现。GET /_requests 可查实际领取请求；POST /_phase 接收 {"phase":1} 切换已定义的来源状态，切回 0 恢复。所有资料都限于公开约定或本地合成数据，不向真实业务系统写入。

## 测试与构建

`npm test` 覆盖现有读取器、畸形输入、真实 HTTP 领取、原件一致性、持久重开、同源边界和范围响应；领域读取行为在 test/domain.test.mjs。`npm run build` 对运行模块逐个执行语法校验并复制到 dist。`docker build -t depot-view:local .` 可创建产品运行镜像；镜像默认运行实际演示，不含远程业务凭据。
