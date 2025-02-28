import {
    addIcon,
    MarkdownPostProcessor,
    MarkdownPostProcessorContext,
    MarkdownPreviewRenderer,
    MarkdownRenderChild,
    MarkdownRenderer,
    MarkdownView,
    Notice,
    Plugin,
    setIcon,
    TFile
} from "obsidian";

import { syntaxTree } from "@codemirror/language";
import {
    ViewPlugin,
    DecorationSet,
    EditorView,
    ViewUpdate,
    Decoration,
    WidgetType
} from "@codemirror/view";

import { tokenClassNodeProp } from "@codemirror/stream-parser";
import { Range } from "@codemirror/rangeset";
import { StateEffect, StateField } from "@codemirror/state";

import {
    Admonition,
    AdmonitionSettings,
    AdmonitionIconDefinition
} from "./@types";
import { getID, getMatches, getParametersFromSource, MSDOCREGEX } from "./util";
import {
    ADMONITION_MAP,
    ADD_ADMONITION_COMMAND_ICON,
    REMOVE_ADMONITION_COMMAND_ICON,
    ADD_COMMAND_NAME,
    REMOVE_COMMAND_NAME
} from "./util";

import type codemirror from "codemirror";

declare global {
    interface Window {
        CodeMirror: typeof codemirror;
    }
}

//add commands to app interface
declare module "obsidian" {
    interface App {
        commands: {
            commands: { [id: string]: Command };
            editorCommands: { [id: string]: Command };
            findCommand(id: string): Command;
            executeCommandById(id: string): void;
            listCommands(): Command[];
            executeCommandById(id: string): void;
            findCommand(id: string): Command;
        };
    }
    interface MarkdownPreviewView {
        renderer: MarkdownPreviewRenderer;
    }
    interface MarkdownPreviewRenderer {
        onCheckboxClick: (evt: MouseEvent, el: HTMLInputElement) => void;
        unregisterCodeBlockPostProcessor(lang: string): void;
    }
}
Object.fromEntries =
    Object.fromEntries ||
    /** Polyfill taken from https://github.com/tc39/proposal-object-from-entries/blob/master/polyfill.js */
    function <T = any>(
        entries: Iterable<readonly [PropertyKey, T]>
    ): { [k: string]: T } {
        const obj = {};

        for (const pair of entries) {
            if (Object(pair) !== pair) {
                throw new TypeError(
                    "iterable for fromEntries should yield objects"
                );
            }
            // Consistency with Map: contract is that entry has "0" and "1" keys, not
            // that it is an array or iterable.
            const { "0": key, "1": val } = pair;

            Object.defineProperty(obj, key, {
                configurable: true,
                enumerable: true,
                writable: true,
                value: val
            });
        }

        return obj;
    };

import AdmonitionSetting from "./settings";
import {
    IconName,
    COPY_BUTTON_ICON,
    iconDefinitions,
    getIconNode
} from "./util/icons";
import { InsertAdmonitionModal } from "./modal";
import "./assets/main.css";
import { isLivePreview, rangesInclude } from "./util/livepreview";

const DEFAULT_APP_SETTINGS: AdmonitionSettings = {
    userAdmonitions: {},
    syntaxHighlight: false,
    copyButton: false,
    version: "",
    warnedAboutNC: false,
    autoCollapse: false,
    defaultCollapseType: "open",
    syncLinks: true,
    enableMarkdownProcessor: false,
    injectColor: true,
    parseTitles: true,
    allowMSSyntax: true,
    livePreviewMS: true,
    dropShadow: true,
    hideEmpty: false
};

export default class ObsidianAdmonition extends Plugin {
    admonitions: { [admonitionType: string]: Admonition } = {};
    data: AdmonitionSettings;

    postprocessors: Map<string, MarkdownPostProcessor> = new Map();

    get types() {
        return Object.keys(this.admonitions);
    }
    get admonitionArray() {
        return Object.keys(this.admonitions).map((key) => {
            return {
                ...this.admonitions[key],
                type: key
            };
        });
    }
    async saveSettings() {
        this.data.version = this.manifest.version;
        await this.saveData(this.data);
    }

    async loadSettings() {
        const loaded: AdmonitionSettings = await this.loadData();
        this.data = Object.assign({}, DEFAULT_APP_SETTINGS, loaded);

        if (
            this.data.userAdmonitions &&
            (!this.data.version || Number(this.data.version.split(".")[0]) < 5)
        ) {
            for (let admonition in this.data.userAdmonitions) {
                if (
                    Object.prototype.hasOwnProperty.call(
                        this.data.userAdmonitions[admonition],
                        "type"
                    )
                )
                    continue;
                this.data.userAdmonitions[admonition] = {
                    ...this.data.userAdmonitions[admonition],
                    icon: {
                        type: "font-awesome",
                        name: this.data.userAdmonitions[admonition]
                            .icon as unknown as IconName
                    }
                };
            }
        }

        if (loaded != null && !this.data.warnedAboutNC) {
            if (Number(this.data.version.split(".")[0]) < 7) {
                new Notice(
                    "Admonitions: Use of the !!!-style Admonitions will be removed in a future version.\n\nPlease update them to the MSDoc-style syntax.",
                    0
                );
            }
            this.data.warnedAboutNC = true;
        }

        this.admonitions = {
            ...ADMONITION_MAP,
            ...this.data.userAdmonitions
        };
        await this.saveSettings();
    }
    async addAdmonition(admonition: Admonition): Promise<void> {
        this.data.userAdmonitions = {
            ...this.data.userAdmonitions,
            [admonition.type]: admonition
        };
        this.admonitions = {
            ...ADMONITION_MAP,
            ...this.data.userAdmonitions
        };
        if (this.data.syntaxHighlight) {
            this.turnOnSyntaxHighlighting([admonition.type]);
        }

        await this.saveSettings();
        const processor = this.registerMarkdownCodeBlockProcessor(
            `ad-${admonition.type}`,
            (src, el, ctx) => this.postprocessor(admonition.type, src, el, ctx)
        );
        this.postprocessors.set(admonition.type, processor);
    }

    async removeAdmonition(admonition: Admonition) {
        if (this.data.userAdmonitions[admonition.type]) {
            delete this.data.userAdmonitions[admonition.type];
        }
        this.admonitions = {
            ...ADMONITION_MAP,
            ...this.data.userAdmonitions
        };

        if (this.data.syntaxHighlight) {
            this.turnOffSyntaxHighlighting([admonition.type]);
        }

        if (admonition.command) {
            this.unregisterCommandsFor(admonition);
        }

        if (this.postprocessors.has(admonition.type)) {
            MarkdownPreviewRenderer.unregisterPostProcessor(
                this.postprocessors.get(admonition.type)
            );
            //@ts-expect-error
            MarkdownPreviewRenderer.unregisterCodeBlockPostProcessor(
                `ad-${admonition.type}`
            );
            this.postprocessors.delete(admonition.type);
        }

        await this.saveSettings();
    }
    async onload(): Promise<void> {
        console.log("Obsidian Admonition loaded");
        await this.loadSettings();
        Object.keys(this.admonitions).forEach((type) => {
            const processor = this.registerMarkdownCodeBlockProcessor(
                `ad-${type}`,
                (src, el, ctx) => this.postprocessor(type, src, el, ctx)
            );
            this.postprocessors.set(type, processor);
            if (this.admonitions[type].command) {
                this.registerCommandsFor(this.admonitions[type]);
            }
        });
        this.app.workspace.onLayoutReady(async () => {
            this.addSettingTab(new AdmonitionSetting(this.app, this));

            addIcon(ADD_COMMAND_NAME.toString(), ADD_ADMONITION_COMMAND_ICON);
            addIcon(
                REMOVE_COMMAND_NAME.toString(),
                REMOVE_ADMONITION_COMMAND_ICON
            );

            if (this.data.enableMarkdownProcessor) {
                this.enableMarkdownProcessor();
            }

            if (this.data.syntaxHighlight) {
                this.turnOnSyntaxHighlighting();
            }

            /** Add generic commands. */
            this.addCommand({
                id: "collapse-admonitions",
                name: "Collapse Admonitions in Note",
                checkCallback: (checking) => {
                    // checking if the command should appear in the Command Palette
                    if (checking) {
                        // make sure the active view is a MarkdownView.
                        return !!this.app.workspace.getActiveViewOfType(
                            MarkdownView
                        );
                    }
                    let view =
                        this.app.workspace.getActiveViewOfType(MarkdownView);
                    if (!view || !(view instanceof MarkdownView)) return;

                    let admonitions = view.contentEl.querySelectorAll(
                        "details[open].admonition-plugin"
                    );
                    for (let i = 0; i < admonitions.length; i++) {
                        let admonition = admonitions[i];
                        admonition.removeAttribute("open");
                    }
                }
            });
            this.addCommand({
                id: "open-admonitions",
                name: "Open Admonitions in Note",
                checkCallback: (checking) => {
                    // checking if the command should appear in the Command Palette
                    if (checking) {
                        // make sure the active view is a MarkdownView.
                        return !!this.app.workspace.getActiveViewOfType(
                            MarkdownView
                        );
                    }
                    let view =
                        this.app.workspace.getActiveViewOfType(MarkdownView);
                    if (!view || !(view instanceof MarkdownView)) return;

                    let admonitions = view.contentEl.querySelectorAll(
                        "details:not([open]).admonition-plugin"
                    );
                    for (let i = 0; i < admonitions.length; i++) {
                        let admonition = admonitions[i];
                        admonition.setAttribute("open", "open");
                    }
                }
            });

            this.addCommand({
                id: "insert-admonition",
                name: "Insert Admonition",
                editorCallback: (editor, view) => {
                    let suggestor = new InsertAdmonitionModal(this, editor);
                    suggestor.open();
                }
            });

            this.registerEvent(
                this.app.metadataCache.on("resolve", (file) => {
                    if (!this.data.syncLinks) return;
                    if (this.app.workspace.getActiveFile() != file) return;

                    const view =
                        this.app.workspace.getActiveViewOfType(MarkdownView);

                    if (!view || !(view instanceof MarkdownView)) return;

                    const admonitionLinks =
                        view.contentEl.querySelectorAll<HTMLAnchorElement>(
                            ".admonition:not(.admonition-plugin-async) a.internal-link"
                        );

                    this.addLinksToCache(admonitionLinks, file.path);
                })
            );

            this.enableMSSyntax();
        });
    }
    getMSParametersFromLine(line: string) {
        let [, type, title, col] = line.match(MSDOCREGEX) ?? [];

        if (
            !type ||
            (!this.admonitions[type] &&
                !Object.keys(this.admonitions)
                    .map((k) => k.toLowerCase())
                    .includes(type.toLowerCase()))
        )
            return;

        if (!(type in this.admonitions)) {
            type = Object.keys(this.admonitions).find(
                (k) => k.toLowerCase() == type.toLowerCase()
            );
        }
        if (!type) return;

        if (title == undefined && !line.match(/^> \[!(\w+):[ ]?/)) {
            title =
                this.admonitions[type].title ??
                `${type[0].toUpperCase()}${type.slice(1).toLowerCase()}`;
        }

        let collapse;
        switch (col) {
            case "+": {
                collapse = "open";
                break;
            }
            case "-": {
                collapse = "closed";
                break;
            }
            case "x": {
                break;
            }
            default: {
                collapse = this.data.autoCollapse
                    ? this.data.defaultCollapseType
                    : null;
            }
        }
        if ((collapse == "closed" || collapse == "open") && !title) {
            title =
                this.admonitions[type].title ??
                `${type[0].toUpperCase()}${type.slice(1).toLowerCase()}`;
        }
        return { type, title, collapse };
    }
    enableMSSyntax() {
        this.registerMarkdownPostProcessor((el, ctx) => {
            if (!this.data.allowMSSyntax) return;
            if (el?.firstChild?.nodeName !== "BLOCKQUOTE") return;

            const section = ctx.getSectionInfo(el);
            if (!section) return;
            const text = section.text.split("\n");
            const firstLine = text[section.lineStart];
            if (!/^> \[!.+\]/.test(firstLine)) return;

            const params = this.getMSParametersFromLine(firstLine);

            if (!params?.type) return;

            const { type, title, collapse } = params;

            const admonition = this.getAdmonitionElement(
                type,
                title,
                this.admonitions[type].icon,
                this.admonitions[type].color,
                collapse
            );

            const content = text
                .slice(section.lineStart + 1, section.lineEnd + 1)
                .join("\n")
                .replace(/> /g, "");

            const contentEl = this.getAdmonitionContentElement(
                type,
                admonition,
                content
            );

            MarkdownRenderer.renderMarkdown(
                content,
                contentEl,
                ctx.sourcePath,
                null
            );

            if (
                (!content.length || contentEl.textContent.trim() == "") &&
                this.data.hideEmpty
            )
                admonition.addClass("no-content");

            el.firstElementChild.replaceWith(admonition);
        });

        type TokenSpec = {
            from: number;
            to: number;
            value: string;
            title: string;
            type: string;
            collapse: string;
        };

        const admonition = StateEffect.define<DecorationSet>();
        class AdmonitionWidget extends WidgetType {
            constructor(
                public type: string,
                public title: string,
                public collapse: string,
                public content: string
            ) {
                super();
            }
            eq(widget: AdmonitionWidget) {
                return (
                    this.type == widget.type &&
                    this.title == widget.title &&
                    this.collapse == widget.collapse &&
                    this.content == widget.content
                );
            }
            toDOM(view: EditorView): HTMLElement {
                const admonitionElement = self.getAdmonitionElement(
                    this.type,
                    this.title,
                    self.admonitions[this.type].icon,
                    self.admonitions[this.type].color,
                    this.collapse
                );

                const parent = createDiv(
                    `cm-embed-block admonition-parent admonition-${this.type}-parent`
                );
                parent.appendChild(admonitionElement);
                const edit = parent.createDiv({
                    cls: "edit-block-button",
                    attr: { "aria-label": "Edit this block" }
                });

                setIcon(edit, "code-glyph");

                edit.onclick = () => {
                    const position = view.posAtDOM(admonitionElement);
                    view.dispatch({
                        selection: {
                            head: position,
                            anchor: position
                        }
                    });
                };

                const content = this.content.replace(/^> /gm, "");
                const contentEl = self.getAdmonitionContentElement(
                    this.type,
                    admonitionElement,
                    content
                );

                MarkdownRenderer.renderMarkdown(content, contentEl, "", null);
                if (
                    (!content.length || contentEl.textContent.trim() == "") &&
                    self.data.hideEmpty
                )
                    admonitionElement.addClass("no-content");
                return parent;
            }
        }

        class StatefulDecorationSet {
            editor: EditorView;
            cache: { [cls: string]: Decoration } = Object.create(null);

            constructor(editor: EditorView) {
                this.editor = editor;
            }
            hash(token: TokenSpec) {
                return `from${token.from}to${token.to}`;
            }
            async compute(tokens: TokenSpec[]) {
                const admonition: Range<Decoration>[] = [];
                for (let token of tokens) {
                    let deco = this.cache[this.hash(token)];
                    if (!deco) {
                        deco = this.cache[this.hash(token)] =
                            Decoration.replace({
                                inclusive: true,
                                widget: new AdmonitionWidget(
                                    token.type,
                                    token.title,
                                    token.collapse,
                                    token.value
                                ),
                                block: true,
                                from: token.from,
                                to: token.to
                            });
                    }
                    admonition.push(deco.range(token.from, token.to));
                }
                return Decoration.set(admonition, true);
            }

            async updateDecos(tokens: TokenSpec[]): Promise<void> {
                const admonitions = await this.compute(tokens);

                // if our compute function returned nothing and the state field still has decorations, clear them out
                if (admonitions || this.editor.state.field(field).size) {
                    this.editor.dispatch({
                        effects: [admonition.of(admonitions ?? Decoration.none)]
                    });
                }
            }
            clearDecos() {
                this.editor.dispatch({
                    effects: [admonition.of(Decoration.none)]
                });
            }
        }

        const self = this;
        const plugin = ViewPlugin.fromClass(
            class {
                manager: StatefulDecorationSet;
                source = false;
                constructor(view: EditorView) {
                    this.manager = new StatefulDecorationSet(view);
                    this.build(view);
                }

                update(update: ViewUpdate) {
                    if (update.heightChanged) return;
                    if (!self.data.livePreviewMS) return;
                    if (!isLivePreview(update.view.state)) {
                        if (this.source == false) {
                            this.source = true;
                            this.manager.updateDecos([]);
                        }
                        return;
                    }

                    if (
                        update.docChanged ||
                        update.viewportChanged ||
                        update.selectionSet ||
                        this.source == true
                    ) {
                        this.source = false;
                        this.build(update.view);
                    }
                }

                destroy() {}

                build(view: EditorView) {
                    if (!self.data.allowMSSyntax) return;
                    if (!self.data.livePreviewMS) return;
                    const targetElements: TokenSpec[] = [];

                    if (!isLivePreview(view.state)) return;

                    for (let { from, to } of view.visibleRanges) {
                        const tree = syntaxTree(view.state);
                        tree.iterate({
                            from,
                            to,
                            enter: (types, from, _) => {
                                const tokenProps =
                                    types.prop(tokenClassNodeProp);

                                const props = new Set(tokenProps?.split(" "));
                                if (!props.has("quote")) return;

                                const original =
                                    view.state.doc.sliceString(from);
                                const split = original.split("\n");
                                const line = split[0];
                                if (!/^> \[!.+\]/.test(line)) return;

                                const params =
                                    self.getMSParametersFromLine(line);

                                if (!params?.type) return;

                                const { type, title, collapse } = params;

                                const end = split.findIndex(
                                    (v) => !/^>/.test(v)
                                );

                                const content = split
                                    .slice(1, end > -1 ? end : undefined)
                                    .join("\n");

                                const to =
                                    from + line.length + content.length + 1;
                                targetElements.push({
                                    from,
                                    to,
                                    value: content?.trim(),
                                    title: title?.trim(),
                                    type: type?.trim(),
                                    collapse
                                });
                            }
                        });
                    }

                    this.manager.updateDecos(targetElements);
                }
            }
        );

        ////////////////
        // Utility Code
        ////////////////
        const field = StateField.define<DecorationSet>({
            create(): DecorationSet {
                return Decoration.none;
            },
            update(deco, tr): DecorationSet {
                return tr.effects.reduce((deco, effect) => {
                    if (effect.is(admonition))
                        return effect.value.update({
                            filter: (_, __, decoration) => {
                                return !rangesInclude(
                                    tr.newSelection.ranges,
                                    decoration.spec.from,
                                    decoration.spec.to
                                );
                            }
                        });
                    return deco;
                }, deco.map(tr.changes));
            },
            provide: (field) => EditorView.decorations.from(field)
        });

        this.registerEditorExtension([plugin, field]);
    }
    enableMarkdownProcessor() {
        if (!this.data.enableMarkdownProcessor) return;
        const TYPE_REGEX = new RegExp(
            `(!{3,}|\\?{3,}\\+?) ad-(${this.types.join("|")})(\\s[\\s\\S]+)?`
        );
        const END_REGEX = new RegExp(`\\-{3,} admonition`);

        let push = false,
            id: string;
        const childMap: Map<
            MarkdownRenderChild,
            { contentEl: HTMLElement; elements: Element[]; loaded: boolean }
        > = new Map();
        const elementMap: Map<Element, MarkdownRenderChild> = new Map();
        const idMap: Map<string, MarkdownRenderChild> = new Map();

        Object.values(this.admonitions)
            .filter(({ command }) => command)
            .forEach((admonition) => {
                this.registerCommandsFor(admonition);
            });

        this.registerMarkdownPostProcessor(async (el, ctx) => {
            if (!this.data.enableMarkdownProcessor) return;

            if (END_REGEX.test(el.textContent) && push) {
                push = false;
                const lastElement = createDiv();
                if (
                    id &&
                    idMap.has(id) &&
                    childMap.has(idMap.get(id)) &&
                    el.children[0].textContent.replace(END_REGEX, "").length
                ) {
                    lastElement.innerHTML = el.children[0].outerHTML.replace(
                        new RegExp(`(<br>)?\\n?${END_REGEX.source}`),
                        ""
                    );
                    const contentEl = childMap.get(idMap.get(id)).contentEl;
                    if (contentEl)
                        contentEl.appendChild(lastElement.children[0]);
                }

                el.children[0].detach();
                return;
            }

            if (!TYPE_REGEX.test(el.textContent) && !push) return;
            if (!push) {
                if (
                    !(
                        Array.from(el.children).find((e) =>
                            TYPE_REGEX.test(e.textContent)
                        ) instanceof HTMLParagraphElement
                    )
                )
                    return;
                push = true;
                let child = new MarkdownRenderChild(el);
                id = getID();
                idMap.set(id, child);

                childMap.set(child, {
                    contentEl: null,
                    elements: [],
                    loaded: false
                });

                child.onload = async () => {
                    const source = el.textContent;

                    let [
                        ,
                        col,
                        type,
                        title = type[0].toUpperCase() +
                            type.slice(1).toLowerCase()
                    ]: string[] = source.match(TYPE_REGEX) ?? [];

                    if (!type) return;
                    let collapse;
                    if (/\?{3,}/.test(col)) {
                        collapse = /\+/.test(col) ? "open" : "closed";
                    }

                    if (
                        (title.trim() === "" || title === '""') &&
                        collapse !== undefined &&
                        collapse !== "none"
                    ) {
                        title =
                            type[0].toUpperCase() + type.slice(1).toLowerCase();
                        new Notice(
                            "An admonition must have a title if it is collapsible."
                        );
                    }
                    const admonition = this.admonitions[type];
                    const admonitionElement =
                        await this.getAdmonitionElementAsync(
                            type,
                            title.trim(),
                            admonition.icon,
                            admonition.injectColor ?? this.data.injectColor
                                ? admonition.color
                                : null,
                            collapse
                        );

                    const contentHolder = admonitionElement.createDiv(
                        "admonition-content-holder"
                    );

                    const contentEl =
                        contentHolder.createDiv("admonition-content");

                    child.containerEl.appendChild(admonitionElement);
                    for (let element of childMap.get(child)?.elements) {
                        contentEl.appendChild(element);
                    }

                    childMap.set(child, {
                        ...childMap.get(child),
                        contentEl: contentEl,
                        loaded: true
                    });
                };

                child.onunload = () => {
                    idMap.delete(id);
                    childMap.delete(child);
                };

                ctx.addChild(child);

                el.children[0].detach();

                return;
            }

            if (id && idMap.get(id)) {
                const child = idMap.get(id);
                childMap.set(child, {
                    ...childMap.get(child),
                    elements: [
                        ...childMap.get(child).elements,
                        ...Array.from(el.children)
                    ]
                });
                elementMap.set(el, child);
                if (childMap.get(child)?.loaded) {
                    for (let element of childMap.get(child)?.elements) {
                        childMap.get(child).contentEl.appendChild(element);
                    }
                }
            }
        });
    }
    disableMarkdownProcessor() {
        /* new Notice("The plugin must be reloaded for this to take effect."); */
        Object.values(this.admonitions)
            .filter(({ command }) => command)
            .forEach((admonition) => {
                this.registerCommandsFor(admonition);
            });
    }
    unregisterCommandsFor(admonition: Admonition) {
        admonition.command = false;

        if (
            this.app.commands.findCommand(
                `obsidian-admonition:insert-${admonition.type}`
            )
        ) {
            delete this.app.commands.editorCommands[
                `obsidian-admonition:insert-${admonition.type}`
            ];
            delete this.app.commands.editorCommands[
                `obsidian-admonition:insert-${admonition.type}-with-title`
            ];
            delete this.app.commands.commands[
                `obsidian-admonition:insert-${admonition.type}`
            ];
            delete this.app.commands.commands[
                `obsidian-admonition:insert-${admonition.type}-with-title`
            ];
        }
    }
    registerCommandsFor(admonition: Admonition) {
        admonition.command = true;
        this.addCommand({
            id: `insert-${admonition.type}`,
            name: `Insert ${admonition.type}`,
            editorCheckCallback: (checking, editor, view) => {
                if (checking) return admonition.command;
                if (admonition.command) {
                    try {
                        editor.getDoc().replaceSelection(
                            `\`\`\`ad-${admonition.type}

${editor.getDoc().getSelection()}

\`\`\`\n`
                        );
                        const cursor = editor.getCursor();
                        editor.setCursor(cursor.line - 2);
                    } catch (e) {
                        new Notice(
                            "There was an issue inserting the admonition."
                        );
                    }
                }
            }
        });
        this.addCommand({
            id: `insert-${admonition.type}-with-title`,
            name: `Insert ${admonition.type} With Title`,
            editorCheckCallback: (checking, editor, view) => {
                if (checking) return admonition.command;
                if (admonition.command) {
                    try {
                        editor.getDoc().replaceSelection(
                            `\`\`\`ad-${admonition.type}
title: 

${editor.getDoc().getSelection()}

\`\`\`\n`
                        );
                        const cursor = editor.getCursor();
                        editor.setCursor(cursor.line - 3);
                    } catch (e) {
                        new Notice(
                            "There was an issue inserting the admonition."
                        );
                    }
                }
            }
        });
        if (this.data.enableMarkdownProcessor) {
            this.addCommand({
                id: `insert-non-${admonition.type}`,
                name: `Insert Non-codeblock ${admonition.type}`,
                editorCheckCallback: (checking, editor, view) => {
                    if (checking)
                        return (
                            admonition.command &&
                            this.data.enableMarkdownProcessor
                        );
                    if (admonition.command) {
                        try {
                            editor.getDoc().replaceSelection(
                                `!!! ad-${admonition.type}\n
${editor.getDoc().getSelection()}\n--- admonition\n`
                            );
                            const cursor = editor.getCursor();
                            editor.setCursor(cursor.line - 2);
                        } catch (e) {
                            new Notice(
                                "There was an issue inserting the admonition."
                            );
                        }
                    }
                }
            });
        }
    }
    turnOnSyntaxHighlighting(types: string[] = Object.keys(this.admonitions)) {
        if (!this.data.syntaxHighlight) return;
        types.forEach((type) => {
            if (this.data.syntaxHighlight) {
                /** Process from @deathau's syntax highlight plugin */
                const [, cmPatchedType] = `${type}`.match(
                    /^([\w+#-]*)[^\n`]*$/
                );
                window.CodeMirror.defineMode(
                    `ad-${cmPatchedType}`,
                    (config, options) => {
                        return window.CodeMirror.getMode({}, "hypermd");
                    }
                );
            }
        });

        this.app.workspace.layoutReady
            ? this.layoutReady()
            : this.app.workspace.onLayoutReady(this.layoutReady.bind(this));
    }

    turnOffSyntaxHighlighting(types: string[] = Object.keys(this.admonitions)) {
        types.forEach((type) => {
            if (window.CodeMirror.modes.hasOwnProperty(`ad-${type}`)) {
                delete window.CodeMirror.modes[`ad-${type}`];
            }
        });
        this.app.workspace.layoutReady
            ? this.layoutReady()
            : this.app.workspace.onLayoutReady(this.layoutReady.bind(this));
    }

    layoutReady() {
        // don't need the event handler anymore, get rid of it
        this.app.workspace.off("layout-ready", this.layoutReady.bind(this));
        this.refreshLeaves();
    }

    refreshLeaves() {
        // re-set the editor mode to refresh the syntax highlighting
        this.app.workspace.iterateCodeMirrors((cm) =>
            cm.setOption("mode", cm.getOption("mode"))
        );
    }
    async postprocessor(
        type: string,
        src: string,
        el: HTMLElement,
        ctx?: MarkdownPostProcessorContext
    ) {
        if (!this.admonitions[type]) {
            return;
        }
        try {
            const sourcePath =
                typeof ctx == "string"
                    ? ctx
                    : ctx?.sourcePath ??
                      this.app.workspace.getActiveFile()?.path ??
                      "";
            let { title, collapse, content, icon, color } =
                getParametersFromSource(type, src, this.admonitions[type]);

            let match = new RegExp(`^!!! ad-(${this.types.join("|")})$`, "gm");

            let nestedAdmonitions = content.match(match) || [];

            if (nestedAdmonitions.length) {
                let matches = [getMatches(content, 0, nestedAdmonitions[0])];
                for (let i = 1; i < nestedAdmonitions.length; i++) {
                    matches.push(
                        getMatches(
                            content,
                            matches[i - 1].end,
                            nestedAdmonitions[i]
                        )
                    );
                }

                let split = content.split("\n");

                for (let m of matches.reverse()) {
                    split.splice(
                        m.start,
                        m.end - m.start + 1,
                        `\`\`\`ad-${m.type}\n${m.src}\n\`\`\``
                    );
                }
                content = split.join("\n");
            }

            if (this.data.autoCollapse && !collapse) {
                collapse = this.data.defaultCollapseType ?? "open";
            } else if (collapse && collapse.trim() === "none") {
                collapse = "";
            }
            const id = getID();

            /* const iconNode = icon ? this.admonitions[type].icon; */
            const admonition = this.admonitions[type];
            let admonitionElement = this.getAdmonitionElement(
                type,
                title,
                iconDefinitions.find(({ name }) => icon === name) ??
                    admonition.icon,
                color ??
                    (admonition.injectColor ?? this.data.injectColor
                        ? admonition.color
                        : null),
                collapse,
                id
            );

            let markdownRenderChild = new MarkdownRenderChild(
                admonitionElement
            );
            markdownRenderChild.containerEl = admonitionElement;
            if (ctx && !(typeof ctx == "string")) {
                /**
                 * Create a unloadable component.
                 */
                markdownRenderChild.onload = () => {
                    /* this.contextMap.set(id, ctx); */
                };
                markdownRenderChild.onunload = () => {
                    /* this.contextMap.delete(id); */
                };
                ctx.addChild(markdownRenderChild);
            }

            if (content && content.length) {
                const contentEl = this.getAdmonitionContentElement(
                    type,
                    admonitionElement,
                    content
                );
                /**
                 * Render the content as markdown and append it to the admonition.
                 */

                if (/^`{3,}mermaid/m.test(content)) {
                    const wasCollapsed =
                        !admonitionElement.hasAttribute("open");
                    if (admonitionElement instanceof HTMLDetailsElement) {
                        admonitionElement.setAttribute("open", "open");
                    }
                    setImmediate(() => {
                        MarkdownRenderer.renderMarkdown(
                            content,
                            contentEl,
                            sourcePath,
                            markdownRenderChild
                        );
                        if (
                            admonitionElement instanceof HTMLDetailsElement &&
                            wasCollapsed
                        ) {
                            admonitionElement.removeAttribute("open");
                        }
                    });
                } else {
                    MarkdownRenderer.renderMarkdown(
                        content,
                        contentEl,
                        sourcePath,
                        markdownRenderChild
                    );
                }

                if (
                    (!content.length || contentEl.textContent.trim() == "") &&
                    this.data.hideEmpty
                )
                    admonitionElement.addClass("no-content");

                const taskLists = contentEl.querySelectorAll<HTMLInputElement>(
                    ".task-list-item-checkbox"
                );
                if (taskLists?.length) {
                    const split = src.split("\n");
                    let slicer = 0;
                    taskLists.forEach((task) => {
                        const line = split
                            .slice(slicer)
                            .findIndex((l) => /^\- \[.\]/.test(l));

                        if (line == -1) return;
                        task.dataset.line = `${line + slicer + 1}`;
                        slicer = line + slicer + 1;
                    });
                }

                const links =
                    contentEl.querySelectorAll<HTMLAnchorElement>(
                        "a.internal-link"
                    );

                this.addLinksToCache(links, sourcePath);
            }

            /**
             * Replace the <pre> tag with the new admonition.
             */
            const parent = el.parentElement;
            if (parent && !parent.hasClass("admonition-content")) {
                parent.addClass(
                    "admonition-parent",
                    `admonition-${type}-parent`
                );
            }
            el.replaceWith(admonitionElement);
            return admonitionElement;
        } catch (e) {
            console.error(e);
            const pre = createEl("pre");

            pre.createEl("code", {
                attr: {
                    style: `color: var(--text-error) !important`
                }
            }).createSpan({
                text:
                    "There was an error rendering the admonition:" +
                    "\n\n" +
                    src
            });

            el.replaceWith(pre);
        }
    }
    async onunload() {
        console.log("Obsidian Admonition unloaded");

        this.turnOffSyntaxHighlighting();
    }
    addLinksToCache(
        links: NodeListOf<HTMLAnchorElement>,
        sourcePath: string
    ): void {
        if (!this.data.syncLinks) return;
        /* //@ts-expect-error
        this.app.metadataCache.resolveLinks(sourcePath); */
        for (let i = 0; i < links.length; i++) {
            const a = links[i];
            if (a.dataset.href) {
                let file = this.app.metadataCache.getFirstLinkpathDest(
                    a.dataset.href,
                    ""
                );
                let cache, path;
                if (file && file instanceof TFile) {
                    cache = this.app.metadataCache.resolvedLinks;
                    path = file.path;
                } else {
                    cache = this.app.metadataCache.unresolvedLinks;
                    path = a.dataset.href;
                }
                if (!cache[sourcePath]) {
                    cache[sourcePath] = {
                        [path]: 0
                    };
                }
                let resolved = cache[sourcePath];
                if (!resolved[path]) {
                    resolved[path] = 0;
                }
                resolved[path] += 1;
                cache[sourcePath] = resolved;
            }
        }
    }
    getAdmonitionElement(
        type: string,
        title: string,
        icon: AdmonitionIconDefinition,
        color?: string,
        collapse?: string,
        id?: string
    ): HTMLElement {
        let admonition, titleEl;
        let attrs: { style?: string; open?: string } = color
            ? {
                  style: `--admonition-color: ${color};`
              }
            : {};
        if (collapse && collapse != "none") {
            if (collapse === "open") {
                attrs.open = "open";
            }
            admonition = createEl("details", {
                cls: `admonition admonition-${type} admonition-plugin`,
                attr: attrs
            });
            titleEl = admonition.createEl("summary", {
                cls: `admonition-title ${
                    !title?.trim().length ? "no-title" : ""
                }`
            });
        } else {
            admonition = createDiv({
                cls: `admonition admonition-${type} admonition-plugin`,
                attr: attrs
            });
            titleEl = admonition.createDiv({
                cls: `admonition-title ${
                    !title?.trim().length ? "no-title" : ""
                }`
            });
        }

        if (id) {
            admonition.id = id;
        }

        if (title && title.trim().length) {
            /**
             * Title structure
             * <div|summary>.admonition-title
             *      <element>.admonition-title-content - Rendered Markdown top-level element (e.g. H1/2/3 etc, p)
             *          div.admonition-title-icon
             *              svg
             *          div.admonition-title-markdown - Container of rendered markdown
             *              ...rendered markdown children...
             */

            //get markdown
            const markdownHolder = createDiv();
            MarkdownRenderer.renderMarkdown(title, markdownHolder, "", null);

            //admonition-title-content is first child of rendered markdown

            const admonitionTitleContent =
                markdownHolder.children[0]?.tagName === "P"
                    ? createDiv()
                    : markdownHolder.children[0];

            //get children of markdown element, then remove them
            const markdownElements = Array.from(
                markdownHolder.children[0]?.childNodes || []
            );
            admonitionTitleContent.innerHTML = "";
            admonitionTitleContent.addClass("admonition-title-content");

            //build icon element
            const iconEl = admonitionTitleContent.createDiv(
                "admonition-title-icon"
            );
            if (icon && icon.name && icon.type) {
                iconEl.appendChild(getIconNode(icon));
            }

            //add markdown children back
            const admonitionTitleMarkdown = admonitionTitleContent.createDiv(
                "admonition-title-markdown"
            );
            for (let i = 0; i < markdownElements.length; i++) {
                admonitionTitleMarkdown.appendChild(markdownElements[i]);
            }
            titleEl.appendChild(admonitionTitleContent || createDiv());
        }

        //add them to title element

        if (collapse) {
            titleEl.createDiv("collapser").createDiv("handle");
        }
        if (!this.data.dropShadow) {
            admonition.addClass("no-drop");
        }
        return admonition;
    }
    getAdmonitionContentElement(
        type: string,
        admonitionElement: HTMLElement,
        content: string
    ) {
        const contentHolder = admonitionElement.createDiv(
            "admonition-content-holder"
        );
        const contentEl = contentHolder.createDiv("admonition-content");
        if (this.admonitions[type].copy ?? this.data.copyButton) {
            let copy = contentHolder
                .createDiv("admonition-content-copy")
                .appendChild(COPY_BUTTON_ICON.cloneNode(true));
            copy.addEventListener("click", () => {
                navigator.clipboard.writeText(content.trim()).then(async () => {
                    new Notice("Admonition content copied to clipboard.");
                });
            });
        }
        return contentEl;
    }
    async getAdmonitionElementAsync(
        type: string,
        title: string,
        icon: AdmonitionIconDefinition,
        color?: string,
        collapse?: string,
        id?: string
    ): Promise<HTMLElement> {
        let admonition,
            titleEl,
            attrs: { style?: string; open?: string } = color
                ? {
                      style: `--admonition-color: ${color};`
                  }
                : {};
        if (collapse) {
            if (collapse === "open") {
                attrs.open = "open";
            }
            admonition = createEl("details", {
                cls: `admonition admonition-${type} admonition-plugin admonition-plugin-async`,
                attr: attrs
            });
            titleEl = admonition.createEl("summary", {
                cls: `admonition-title ${
                    !title.trim().length ? "no-title" : ""
                }`
            });
        } else {
            admonition = createDiv({
                cls: `admonition admonition-${type} admonition-plugin`,
                attr: attrs
            });
            titleEl = admonition.createDiv({
                cls: `admonition-title ${
                    !title.trim().length ? "no-title" : ""
                }`
            });
        }

        if (id) {
            admonition.id = id;
        }

        if (title && title.trim().length) {
            //
            // Title structure
            // <div|summary>.admonition-title
            //      <element>.admonition-title-content - Rendered Markdown top-level element (e.g. H1/2/3 etc, p)
            //          div.admonition-title-icon
            //              svg
            //          div.admonition-title-markdown - Container of rendered markdown
            //              ...rendered markdown children...
            //

            //get markdown
            if (this.data.parseTitles) {
                const markdownHolder = createDiv();
                await MarkdownRenderer.renderMarkdown(
                    title,
                    markdownHolder,
                    "",
                    null
                );

                //admonition-title-content is first child of rendered markdown

                const admonitionTitleContent =
                    markdownHolder.children[0].tagName === "P"
                        ? createDiv()
                        : markdownHolder.children[0];

                //get children of markdown element, then remove them
                const markdownElements = Array.from(
                    markdownHolder.children[0]?.childNodes || []
                );
                admonitionTitleContent.innerHTML = "";
                admonitionTitleContent.addClass("admonition-title-content");

                //build icon element
                const iconEl = admonitionTitleContent.createDiv(
                    "admonition-title-icon"
                );
                if (icon && icon.name && icon.type) {
                    iconEl.appendChild(getIconNode(icon));
                }

                //add markdown children back
                const admonitionTitleMarkdown =
                    admonitionTitleContent.createDiv(
                        "admonition-title-markdown"
                    );
                for (let i = 0; i < markdownElements.length; i++) {
                    admonitionTitleMarkdown.appendChild(markdownElements[i]);
                }
                titleEl.appendChild(admonitionTitleContent || createDiv());
            } else {
                titleEl.appendChild(createDiv({ text: title }));
            }
        }

        //add them to title element

        if (collapse) {
            titleEl.createDiv("collapser").createDiv("handle");
        }
        if (!this.data.dropShadow) {
            admonition.addClass("no-drop");
        }
        return admonition;
    }
}
