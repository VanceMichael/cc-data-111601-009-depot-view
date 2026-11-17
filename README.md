# depot-view

设计库视图重映射后的文件资料领取相关资料接收服务，面向授权来源的原件领取、解释和持久查询。

## 当前能力

支持查看 depot 文件修订和 changelist 原始事件，并提供基于客户视图（Perforce client view 语义子集）的交付领取：

- 按视图行顺序裁决 depot 修订身份到交付路径的映射，`...`/`*` 通配依序替换，`-` 排除、`+` 覆盖/叠加；
- depot 修订身份（depotFile#rev）、交付路径、移动关系分开持久记录，移动不会被误记成删除+新建；
- 同交付路径出现不同内容时报告映射碰撞并停在可核对状态（409/blocked），不挑选赢家、不覆盖字节；
- 跟进 changelist 只处理本交付相关文件，移动对独立配对，视图外文件进入 skipped；
- 切换视图后解释哪些变化来自视图（路径移动、纳入、排除），哪些来自供应商源修订变化。

`src/reader.mjs` 提供单件读取契约与视图/changelist/内容索引解释；`src/view.mjs` 是纯领域视图引擎；`src/delivery.mjs` 编排领取、跟进与视图刷新；`src/transport.mjs` 只访问配置来源的同源地址，拒绝隐式跳转；`src/store.mjs` 保存原件摘要、交付投影与解释结果。`src/service.mjs` 是产品入口，`src/provider.mjs` 是独立 HTTP 联调来源，内容为无个人信息的本地样例。

## 环境与运行

Node.js 22.22 至 22.x，无 npm 依赖，无外部运行服务或下载步骤。Linux、Windows 均使用以下命令；干净目录可直接运行。

```sh
npm ci --offline --ignore-scripts
npm test
npm run build
npm run demo
```

`npm run demo` 自动在本机回环端口启动来源与产品，完整演示视图领取、changelist 移动跟进、阶段 1 视图切换触发映射碰撞并停在 blocked、切回视图后恢复，然后关闭服务并清理临时目录。它展示当前产品能力，不打印预先保存的结果。演示没有固定等待、外网访问或人工操作，通常数秒结束。不要以打印预先保存的结果替代运行。

分开运行时，先 `npm run source`，来源监听 127.0.0.1:4101；在另一终端设置 SOURCE_URL=http://127.0.0.1:4101 后运行 `npm start`，产品默认 4102。DATA_DIR 可设置资料目录，PORT 可分别覆盖监听端口。构建产物位于 dist，当前脚本仅使用 Node 内置模块。

## 已有接口

- GET /health：服务状态。
- POST /intakes，JSON 为 {"path":"/primary"}：按现有 reader 接收单件原件；内容解释失败不登记资料。
- GET /records：持久接收目录；同 source URL、同摘要重领返回原 id。
- GET /objects/{digest}：读取已保存的原始字节。
- POST /deliveries，JSON 可选 {"name":"客户名"}：按当前视图领取一份交付，返回完整交付记录；存在映射碰撞时 HTTP 409，记录状态为 blocked 且已持久化。
- GET /deliveries：列出全部交付记录。
- GET /deliveries/{id}：读取单份交付（台账、条目、排除项、碰撞、移动、历史）。
- POST /deliveries/{id}/changes，JSON 为 {"route":"/changes/11"}：跟进本交付相关的 changelist；blocked 状态或未知路由被拒绝。
- POST /deliveries/{id}/refresh：重新拉取视图并解释视图驱动变化与源修订变化；产生碰撞时返回 409。
- GET /delivery-objects/{digest}：读取交付投影保存的内容字节（内容寻址，与 /objects 的原始字节分开）。

前四项是兼容接口，后续扩展可以新增业务入口，但不能把 GET 请求变为写操作。收件记录当前只包含单件 raw 对象，不代表关联资料已完整。

## 交付记录结构

- `ledger`：depot 修订身份台账（含被视图排除者），每项带 `alive` 与 `replacedBy`，移动通过替换链表达而非删除重建；
- `entries`：当前可见交付条目，交付路径与 `depotFile#rev` 身份分字段保存，`sources` 保留命中的视图行；
- `excluded`：被视图排除的身份及命中行证据——视图排除不是 depot 删除；
- `collisions`：映射碰撞候选及各自内容摘要，供人工核对；
- `moves`：changelist 移动对，两端分别记录 depot 身份与当时的交付路径；
- `lastExplanation`：最近一次视图切换的解释（viewDriven/sourceDriven 分开）；
- `history`：只包含本交付自己的领取、跟进、刷新事件。

## 来源与资料

交换范围、字段和边界见 [来源约定](docs/upstream.md)，样例资源清单可访问来源的 /catalog。`fixtures/upstream.json` 描述 HTTP 资源和阶段变体，不包含产品实现。GET /_requests 可查实际领取请求；POST /_phase 接收 {"phase":1} 切换已定义的来源状态，切回 0 恢复。所有资料都限于公开约定或本地合成数据，不向真实业务系统写入。

## 测试与构建

`npm test` 覆盖现有读取器、畸形输入、真实 HTTP 领取、原件一致性、持久重开、同源边界和范围响应；领域视图行为（映射顺序、排除/覆盖、碰撞、移动配对、视图解释）在 test/view.test.mjs，交付用例端到端行为在 test/delivery.test.mjs。`npm run build` 对运行模块逐个执行语法校验并复制到 dist。`docker build -t depot-view:local .` 可创建产品运行镜像；镜像默认运行实际演示，不含远程业务凭据。
