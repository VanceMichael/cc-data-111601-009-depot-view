# 来源约定

## 产品交换范围

只读 HTTP 交付模拟 Perforce client view 语义，不启动或操作真实 Perforce 服务。/view 的 lines 依序映射 depot 到 //delivery；... 匹配任意路径片段，* 匹配单层字符，通配捕获依序替换目标；引号容纳空格。- 为排除，+ 为覆盖/叠加；普通后续命中替换先前目标，覆盖映射可保留多个来源，但同一交付路径的不同内容属于碰撞，不能 silent overwrite。/primary 是 change=10 的源修订表，/changes/11 提供移动对，/contents 以 depotFile#rev 给出内容。文件对象身份与交付路径独立；视图变更本身不是 depot 删除。阶段 1 修改视图并引入不同来源同交付名的情形。

## 当前来源路由

- `/primary`：application/json
- `/view`：application/json
- `/changes/11`：application/json
- `/contents`：application/json

`/catalog` 提供入口及业务选择。资源字节支持 GET/HEAD、单一 bytes 范围、ETag 和 If-Match，响应不会跨来源重定向。`/_phase` 为联调控制路径，不是产品数据来源，不应由产品自行切换阶段。

## 依据和范围说明

- https://www.perforce.com/manuals/cmdref/Content/CmdRef/views.html

以上是格式或业务词汇的公开依据；本项目明确限定的交换子集以本文及实际资源为准，未要求完整标准实现。元数据和未支持声明应保留可定位的来源，不把未知转换成已确认的空结果。HTTP 来源状态、原件结构和产品接收完整性是不同层次；现有通用收件接口成功只表示该单件已保存。

## 产品侧投影边界

- 视图行按数组顺序裁决：普通 include 后续命中替换先前目标；`-` 清空此前裁决，其后的 include 可重新纳入；`+` 叠加来源，同一交付路径保留多个候选。
- 同交付路径的多候选按内容指纹判定：内容一致视为别名（候选全部保留在 `sources`），内容不一致为映射碰撞，交付进入 blocked，不选择赢家、不落盘该路径。
- 领取与 changelist 跟进只信任主修订表与移动对中的 depot 身份；内容索引里仅由 `+` 覆盖行映射的额外身份才会进入交付，普通 include 不引入超前修订。视图刷新时所有可见身份参与核对以暴露碰撞。
- 移动关系（`moves`）、修订身份台账（`ledger`，含替换链）与交付路径（`entries`）是三类独立记录；视图排除进入 `excluded` 并保留命中行证据，不等同于 depot 删除。
- `/_phase` 仅用于联调；产品自身不切换阶段，视图刷新只如实读取来源当前 `/view` 并把变化解释为 viewDriven 或 sourceDriven。
