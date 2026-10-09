/**
 * Wallpaper manager panel.
 *
 * Runs inside the host's sandboxed iframe, so it has no access to the host DOM,
 * no filesystem, and no way to call the backend (the host exposes no
 * `backend.call`). It therefore cannot offer a file picker that actually applies
 * a wallpaper — the honest thing is to tell the user exactly where to drop the
 * file, and to show what the manager will accept.
 *
 * Everything here is presentation. The work happens in `server/index.js`.
 */
(() => {
	const PLUGIN_ID = "cn.mcd7.neglectdream.anime-glass";
	const DROP_DIR = `~/.narrafork/plugins/data/${PLUGIN_ID}/wallpapers`;

	const FILES = [
		{ name: "day.png", effect: "浅色主题壁纸（静态）", theme: "AnimeGlass" },
		{ name: "day.gif", effect: "浅色主题壁纸（动图）", theme: "AnimeGlass Live" },
		{ name: "night.png", effect: "深色主题壁纸（静态）", theme: "AnimeGlass" },
		{ name: "night.gif", effect: "深色主题壁纸（动图）", theme: "AnimeGlass Live" },
	];

	function element(tag, text, className) {
		const node = document.createElement(tag);
		if (text !== undefined) node.textContent = text;
		if (className) node.className = className;
		return node;
	}

	const root = document.body;
	root.className = "wp-root";

	root.appendChild(element("h1", "壁纸管理"));
	root.appendChild(
		element(
			"p",
			"插件自带的默认壁纸已经放进下面的文件夹了，直接用你的图片替换同名文件即可 —— 不需要重新打包或重装插件。",
			"wp-lede",
		),
	);

	const pathBox = element("div", undefined, "wp-path");
	pathBox.appendChild(element("span", "壁纸文件夹", "wp-path-label"));
	pathBox.appendChild(element("code", DROP_DIR, "wp-path-value"));
	root.appendChild(pathBox);

	root.appendChild(element("h2", "支持的文件名"));

	const table = element("table", undefined, "wp-table");
	const head = element("tr");
	for (const label of ["文件名", "作用", "对应主题"]) head.appendChild(element("th", label));
	table.appendChild(head);
	for (const file of FILES) {
		const row = element("tr");
		row.appendChild(element("td", file.name, "wp-file"));
		row.appendChild(element("td", file.effect));
		row.appendChild(element("td", file.theme));
		table.appendChild(row);
	}
	root.appendChild(table);

	root.appendChild(element("h2", "步骤"));
	const steps = element("ol", undefined, "wp-steps");
	for (const text of [
		"打开上面的文件夹。",
		"把你的图片改成上表中的文件名放进去，例如 day.png。",
		"等几秒，后端每 2.5 秒检查一次，壁纸会自动更新 —— 不需要刷新浏览器。",
		"如果面板配色也要跟着变，到插件管理里把本插件禁用再启用一次（或重启 NarraFork）。",
	]) {
		steps.appendChild(element("li", text));
	}
	root.appendChild(steps);

	const notes = element("div", undefined, "wp-notes");
	notes.appendChild(
		element(
			"p",
			"格式按文件内容校验：扩展名与实际字节不符的文件会被跳过并记录原因，不会强行改名写入。",
		),
	);
	notes.appendChild(element("p", "支持 PNG / JPEG / WebP / GIF，单文件上限 10 MiB（宿主的硬上限）。"));
	notes.appendChild(
		element(
			"p",
			"壁纸会立即生效：后端按内容哈希给文件命名，换图后资源 URL 随之改变，浏览器不会拿旧缓存糊弄你。",
		),
	);
	notes.appendChild(
		element(
			"p",
			"为什么配色要重载插件：颜色写在 manifest.json 里，宿主只在安装/启用/禁用/卸载时重新编译主题 CSS，插件自己触发不了。",
		),
	);
	notes.appendChild(
		element(
			"p",
			"视频壁纸（mp4 等）无法支持：宿主的主题资源白名单只允许位图，不含视频类型。",
		),
	);
	root.appendChild(notes);
})();
