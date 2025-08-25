import {
	VSCodeBadge,
	VSCodeButton,
	VSCodeCheckbox,
	VSCodeDataGrid,
	VSCodeDataGridCell,
	VSCodeDataGridRow,
	VSCodeDivider,
	VSCodeDropdown,
	VSCodeLink,
	VSCodeOption,
	VSCodePanels,
	VSCodePanelTab,
	VSCodePanelView,
	VSCodeProgressRing,
	VSCodeRadio,
	VSCodeRadioGroup,
	VSCodeTag,
	VSCodeTextArea,
	VSCodeTextField,
} from "@vscode/webview-ui-toolkit/react"

function Demo() {
	const rowData = [
		{
			cell1: "单元格数据",
			cell2: "单元格数据",
			cell3: "单元格数据",
			cell4: "单元格数据",
		},
		{
			cell1: "单元格数据",
			cell2: "单元格数据",
			cell3: "单元格数据",
			cell4: "单元格数据",
		},
		{
			cell1: "单元格数据",
			cell2: "单元格数据",
			cell3: "单元格数据",
			cell4: "单元格数据",
		},
	]

	return (
		<main>
			<h1>你好世界！</h1>
			<VSCodeButton>你好！</VSCodeButton>

			<div className="grid gap-3 p-2 place-items-start">
				<VSCodeDataGrid>
					<VSCodeDataGridRow row-type="header">
						<VSCodeDataGridCell cell-type="columnheader" grid-column="1">
							自定义标题
						</VSCodeDataGridCell>
						<VSCodeDataGridCell cell-type="columnheader" grid-column="2">
							另一个自定义标题
						</VSCodeDataGridCell>
						<VSCodeDataGridCell cell-type="columnheader" grid-column="3">
							标题是自定义的
						</VSCodeDataGridCell>
						<VSCodeDataGridCell cell-type="columnheader" grid-column="4">
							自定义标题
						</VSCodeDataGridCell>
					</VSCodeDataGridRow>
					{rowData.map((row, index) => (
						<VSCodeDataGridRow key={index}>
							<VSCodeDataGridCell grid-column="1">{row.cell1}</VSCodeDataGridCell>
							<VSCodeDataGridCell grid-column="2">{row.cell2}</VSCodeDataGridCell>
							<VSCodeDataGridCell grid-column="3">{row.cell3}</VSCodeDataGridCell>
							<VSCodeDataGridCell grid-column="4">{row.cell4}</VSCodeDataGridCell>
						</VSCodeDataGridRow>
					))}
				</VSCodeDataGrid>

				<VSCodeTextField>
					<section slot="end" style={{ display: "flex", alignItems: "center" }}>
						<VSCodeButton appearance="icon" aria-label="匹配大小写">
							<span className="codicon codicon-case-sensitive"></span>
						</VSCodeButton>
						<VSCodeButton appearance="icon" aria-label="匹配整个单词">
							<span className="codicon codicon-whole-word"></span>
						</VSCodeButton>
						<VSCodeButton appearance="icon" aria-label="使用正则表达式">
							<span className="codicon codicon-regex"></span>
						</VSCodeButton>
					</section>
				</VSCodeTextField>
				<span slot="end" className="codicon codicon-chevron-right"></span>

				<span className="flex gap-3">
					<VSCodeProgressRing />
					<VSCodeTextField />
					<VSCodeButton>添加</VSCodeButton>
					<VSCodeButton appearance="secondary">删除</VSCodeButton>
				</span>

				<VSCodeBadge>徽章</VSCodeBadge>
				<VSCodeCheckbox>复选框</VSCodeCheckbox>
				<VSCodeDivider />
				<VSCodeDropdown>
					<VSCodeOption>选项 1</VSCodeOption>
					<VSCodeOption>选项 2</VSCodeOption>
				</VSCodeDropdown>
				<VSCodeLink href="#">链接</VSCodeLink>
				<VSCodePanels>
					<VSCodePanelTab id="tab-1">标签 1</VSCodePanelTab>
					<VSCodePanelTab id="tab-2">标签 2</VSCodePanelTab>
					<VSCodePanelView id="view-1">面板视图 1</VSCodePanelView>
					<VSCodePanelView id="view-2">面板视图 2</VSCodePanelView>
				</VSCodePanels>
				<VSCodeRadioGroup>
					<VSCodeRadio>单选 1</VSCodeRadio>
					<VSCodeRadio>单选 2</VSCodeRadio>
				</VSCodeRadioGroup>
				<VSCodeTag>标签</VSCodeTag>
				<VSCodeTextArea placeholder="文本区域" />
			</div>
		</main>
	)
}

export default Demo
