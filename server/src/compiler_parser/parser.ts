// https://www.angelcode.com/angelscript/sdk/docs/manual/doc_script_bnf.html

import {
    AccessModifier,
    EntityAttribute,
    funcHeadConstructor,
    funcHeadDestructor,
    FuncHeads,
    FunctionAttribute,
    isFunctionHeadReturnValue,
    makeParsedRange,
    NodeArgList,
    NodeAssign,
    NodeBreak,
    NodeCase,
    NodeCast,
    NodeClass,
    NodeCondition,
    NodeConstructCall,
    NodeContinue,
    NodeDataType,
    NodeDoWhile,
    NodeEnum,
    NodeExpr,
    NodeExprPostOp,
    NodeExprPostOp1,
    NodeExprPostOp2,
    NodeExprStat,
    NodeExprTerm1,
    NodeExprTerm2,
    NodeExprValue,
    NodeFor,
    NodeFunc,
    NodeFuncCall,
    NodeFuncDef,
    NodeIf,
    NodeImport,
    NodeInitList,
    NodeInterface,
    NodeIntfMethod,
    NodeLambda,
    NodeLiteral,
    NodeMixin,
    NodeName,
    NodeNamespace,
    NodeParamList,
    NodeReturn,
    NodesBase,
    NodeScope,
    NodeScript,
    NodeStatBlock,
    NodeStatement,
    NodeSwitch,
    NodeTry,
    NodeType,
    NodeTypeDef,
    NodeVar,
    NodeVarAccess,
    NodeVirtualProp,
    NodeWhile,
    ParsedArgument,
    ParsedEnumMember,
    ParsedGetterSetter,
    ParsedPostIndexer,
    ParsedVariableInit,
    ReferenceModifier,
    TypeModifier
} from "./nodes";
import {HighlightToken} from "../code/highlight";
import {TokenKind, TokenObject, TokenReserved} from "../compiler_tokenizer/tokenObject";
import {BreakOrThrough, ParsedResult, ParseFailure, ParserState} from "./parserState";
import {ParsedCacheKind} from "./parsedCache";
import {isTokensLinkedBy} from "../compiler_tokenizer/tokenUtils";
import {Mutable} from "../utils/utilities";
import {getLocationBetween, setEntityAttribute, setFunctionAttribute} from "./nodesUtils";

// SCRIPT        ::= {IMPORT | ENUM | TYPEDEF | CLASS | MIXIN | INTERFACE | FUNCDEF | VIRTPROP | VAR | FUNC | NAMESPACE | ';'}
function parseScript(parser: ParserState): NodeScript {
    const script: NodeScript = [];
    while (parser.isEnd() === false) {
        if (parser.next().text === ';') {
            parser.commit(HighlightToken.Operator);
            continue;
        }

        const parsedImport = parseImport(parser);
        if (parsedImport === ParseFailure.Pending) continue;
        if (parsedImport !== ParseFailure.Mismatch) {
            script.push(parsedImport);
            continue;
        }

        const parsedTypeDef = parseTypeDef(parser);
        if (parsedTypeDef === ParseFailure.Pending) continue;
        if (parsedTypeDef !== ParseFailure.Mismatch) {
            script.push(parsedTypeDef);
            continue;
        }

        const parsedMixin = parseMixin(parser);
        if (parsedMixin === ParseFailure.Pending) continue;
        if (parsedMixin !== ParseFailure.Mismatch) {
            script.push(parsedMixin);
            continue;
        }

        const parsedNamespace = parseNamespace(parser);
        if (parsedNamespace === ParseFailure.Pending) continue;
        if (parsedNamespace !== ParseFailure.Mismatch) {
            script.push(parsedNamespace);
            continue;
        }

        const parsedClass = parseClass(parser);
        if (parsedClass === ParseFailure.Pending) continue;
        if (parsedClass !== ParseFailure.Mismatch) {
            script.push(parsedClass);
            continue;
        }

        const parsedInterface = parseInterface(parser);
        if (parsedInterface === ParseFailure.Pending) continue;
        if (parsedInterface !== ParseFailure.Mismatch) {
            script.push(parsedInterface);
            continue;
        }

        const parsedEnum = parseEnum(parser);
        if (parsedEnum === ParseFailure.Pending) continue;
        if (parsedEnum !== ParseFailure.Mismatch) {
            script.push(parsedEnum);
            continue;
        }

        const parsedFuncDef = parseFuncDef(parser);
        if (parsedFuncDef === ParseFailure.Pending) continue;
        if (parsedFuncDef !== ParseFailure.Mismatch) {
            script.push(parsedFuncDef);
            continue;
        }

        const parsedFunc = parseFunc(parser);
        if (parsedFunc !== undefined) {
            script.push(parsedFunc);
            continue;
        }

        const parsedVirtualProp = parseVirtualProp(parser);
        if (parsedVirtualProp !== undefined) {
            script.push(parsedVirtualProp);
            continue;
        }

        parseMetadata(parser);
        const parsedVar = parseVar(parser);
        if (parsedVar !== undefined) {
            script.push(parsedVar);
            continue;
        }

        break;
    }
    return script;
}

// NAMESPACE     ::= 'namespace' IDENTIFIER {'::' IDENTIFIER} '{' SCRIPT '}'
function parseNamespace(parser: ParserState): ParsedResult<NodeNamespace> {
    if (parser.next().text !== 'namespace') return ParseFailure.Mismatch;
    const rangeStart = parser.next();
    parser.commit(HighlightToken.Builtin);

    const namespaceList: TokenObject[] = [];
    while (parser.isEnd() === false) {
        const identifier = expectIdentifier(parser, HighlightToken.Namespace);
        if (identifier !== undefined) namespaceList.push(identifier);

        if (expectContinuousOrClose(parser, '::', '{', true) === BreakOrThrough.Break) break;

        if (identifier === undefined) parser.step();
    }

    if (namespaceList.length === 0) {
        return ParseFailure.Pending;
    }

    const script = parseScript(parser);

    parser.expect('}', HighlightToken.Operator);

    return {
        nodeName: NodeName.Namespace,
        nodeRange: {start: rangeStart, end: parser.prev()},
        namespaceList: namespaceList,
        script: script
    };
}

function parseIdentifier(parser: ParserState, kind: HighlightToken): TokenObject | undefined {
    const identifier = parser.next();
    if (identifier.kind !== TokenKind.Identifier) return undefined;
    parser.commit(kind);
    return identifier;
}

function expectIdentifier(parser: ParserState, kind: HighlightToken): TokenObject | undefined {
    const identifier = parseIdentifier(parser, kind);
    if (identifier === undefined) {
        parser.error("Expected identifier.");
    }
    return identifier;
}

function expectContextualKeyword(parser: ParserState, keyword: string): boolean {
    if (parser.next().text !== keyword) {
        parser.error(`Expected '${keyword}'.`);
        return false;
    }
    parser.commit(HighlightToken.Keyword);
    return true;
}

// ENUM          ::= {'shared' | 'external'} 'enum' IDENTIFIER (';' | ('{' IDENTIFIER ['=' EXPR] {',' IDENTIFIER ['=' EXPR]} [','] '}'))
function parseEnum(parser: ParserState): ParsedResult<NodeEnum> {
    const rangeStart = parser.next();

    const entity = parseEntityAttribute(parser);

    if (parser.next().text !== 'enum') {
        parser.backtrack(rangeStart);
        return ParseFailure.Mismatch;
    }
    parser.commit(HighlightToken.Builtin);

    const identifier = expectIdentifier(parser, HighlightToken.Enum);
    if (identifier === undefined) return ParseFailure.Pending;

    let memberList: ParsedEnumMember[] = [];
    const scopeStart = parser.next();

    if (parser.next().text === ';') {
        parser.commit(HighlightToken.Operator);
    } else {
        memberList = expectEnumMembers(parser);
    }

    return {
        nodeName: NodeName.Enum,
        nodeRange: {start: rangeStart, end: parser.prev()},
        scopeRange: {start: scopeStart, end: parser.prev()},
        entity: entity,
        identifier: identifier,
        memberList: memberList
    };
}

// '{' IDENTIFIER ['=' EXPR] {',' IDENTIFIER ['=' EXPR]} [','] '}'
function expectEnumMembers(parser: ParserState): ParsedEnumMember[] {
    const members: ParsedEnumMember[] = [];
    parser.expect('{', HighlightToken.Operator);
    while (parser.isEnd() === false) {
        if (expectContinuousOrClose(parser, ',', '}', members.length > 0) === BreakOrThrough.Break) break;

        if (parser.next().text === '}') {
            parser.commit(HighlightToken.Operator);
            break;
        }

        const identifier = expectIdentifier(parser, HighlightToken.EnumMember);
        if (identifier === undefined) break;

        let expr: NodeExpr | undefined = undefined;
        if (parser.next().text === '=') {
            parser.commit(HighlightToken.Operator);
            expr = expectExpr(parser);
        }

        members.push({identifier: identifier, expr: expr});
    }

    return members;

}

// {'shared' | 'abstract' | 'final' | 'external'}
function parseEntityAttribute(parser: ParserState): EntityAttribute | undefined {
    const cache = parser.cache(ParsedCacheKind.EntityAttribute);
    if (cache.restore !== undefined) return cache.restore();

    let attribute: EntityAttribute | undefined = undefined;
    while (parser.isEnd() === false) {
        const next = parser.next().text;
        const isEntityToken = next === 'shared' || next === 'external' || next === 'abstract' || next === 'final';
        if (isEntityToken === false) break;
        if (attribute === undefined) attribute = {
            isShared: false,
            isExternal: false,
            isAbstract: false,
            isFinal: false
        };
        setEntityAttribute(attribute, next);
        parser.commit(HighlightToken.Builtin);
    }

    cache.store(attribute);
    return attribute;
}

// CLASS         ::= {'shared' | 'abstract' | 'final' | 'external'} 'class' IDENTIFIER (';' | ([':' IDENTIFIER {',' IDENTIFIER}] '{' {VIRTPROP | FUNC | VAR | FUNCDEF} '}'))
function parseClass(parser: ParserState): ParsedResult<NodeClass> {
    const rangeStart = parser.next();

    const metadata = parseMetadata(parser);

    const entity = parseEntityAttribute(parser);

    if (parser.next().text !== 'class') {
        parser.backtrack(rangeStart);
        return ParseFailure.Mismatch;
    }
    parser.commit(HighlightToken.Builtin);

    const identifier = expectIdentifier(parser, HighlightToken.Class);
    if (identifier === undefined) return ParseFailure.Pending;

    const typeTemplates = parseTypeTemplates(parser);

    const baseList: TokenObject[] = [];
    if (parser.next().text === ':') {
        parser.commit(HighlightToken.Operator);
        while (parser.isEnd() === false) {
            const identifier = expectIdentifier(parser, HighlightToken.Type);
            if (identifier !== undefined) baseList.push(identifier);

            if (expectContinuousOrClose(parser, ',', '{', true) === BreakOrThrough.Break) break;

            if (identifier === undefined) parser.step();
        }
    } else {
        parser.expect('{', HighlightToken.Operator);
    }

    const scopeStart = parser.next();
    const members = expectClassMembers(parser);
    const scopeEnd = parser.prev();

    return {
        nodeName: NodeName.Class,
        nodeRange: {start: rangeStart, end: parser.prev()},
        scopeRange: {start: scopeStart, end: scopeEnd},
        metadata: metadata,
        entity: entity,
        identifier: identifier,
        typeTemplates: typeTemplates,
        baseList: baseList,
        memberList: members
    };
}

// '{' {VIRTPROP | FUNC | VAR | FUNCDEF} '}'
function expectClassMembers(parser: ParserState) {
    // parser.expect('{', HighlightTokenKind.Operator);
    const members: (NodeVirtualProp | NodeVar | NodeFunc | NodeFuncDef)[] = [];
    while (parser.isEnd() === false) {
        if (parseCloseOperator(parser, '}') === BreakOrThrough.Break) break;

        const parsedFuncDef = parseFuncDef(parser);
        if (parsedFuncDef === ParseFailure.Pending) continue;
        if (parsedFuncDef !== ParseFailure.Mismatch) {
            members.push(parsedFuncDef);
            continue;
        }

        const parsedFunc = parseFunc(parser);
        if (parsedFunc !== undefined) {
            members.push(parsedFunc);
            continue;
        }

        const parsedVirtualProp = parseVirtualProp(parser);
        if (parsedVirtualProp !== undefined) {
            members.push(parsedVirtualProp);
            continue;
        }

        const parsedVar = parseVar(parser);
        if (parsedVar !== undefined) {
            members.push(parsedVar);
            continue;
        }

        parser.error("Expected class member.");
        parser.step();
    }

    return members;
}

// TYPEDEF       ::= 'typedef' PRIMTYPE IDENTIFIER ';'
function parseTypeDef(parser: ParserState): ParsedResult<NodeTypeDef> {
    if (parser.next().text !== 'typedef') return ParseFailure.Mismatch;
    const rangeStart = parser.next();
    parser.commit(HighlightToken.Builtin);

    const primeType = parsePrimeType(parser);
    if (primeType === undefined) {
        parser.error("Expected primitive type.");
        return ParseFailure.Pending;
    }

    const identifier = parser.next();
    parser.commit(HighlightToken.Type);

    parser.expect(';', HighlightToken.Operator);

    return {
        nodeName: NodeName.TypeDef,
        nodeRange: {start: rangeStart, end: parser.prev()},
        type: primeType,
        identifier: identifier
    };
}

// FUNC          ::= {'shared' | 'external'} ['private' | 'protected'] [((TYPE ['&']) | '~')] IDENTIFIER PARAMLIST ['const'] FUNCATTR (';' | STATBLOCK)
function parseFunc(parser: ParserState): NodeFunc | undefined {
    const rangeStart = parser.next();

    parseMetadata(parser);

    const entityAttribute = parseEntityAttribute(parser);

    const accessor = parseAccessModifier(parser);

    let head: FuncHeads;
    if (parser.next().text === '~') {
        parser.commit(HighlightToken.Operator);
        head = funcHeadDestructor;
    } else if (parser.next(0).kind === TokenKind.Identifier && parser.next(1).text === '(') {
        head = funcHeadConstructor;
    } else {
        const returnType = parseType(parser);
        if (returnType === undefined) {
            parser.backtrack(rangeStart);
            return undefined;
        }

        const isRef = parseRef(parser);

        head = {returnType: returnType, isRef: isRef};
    }
    const identifier = parser.next();
    parser.commit(isFunctionHeadReturnValue(head) ? HighlightToken.Function : HighlightToken.Type);

    const typeTemplates = parseTypeTemplates(parser);

    const paramList = parseParamList(parser);
    if (paramList === undefined) {
        parser.backtrack(rangeStart);
        return undefined;
    }

    const isConst = parseConst(parser);

    const funcAttr = parseFuncAttr(parser);

    const statStart = parser.next().text;

    let statBlock: NodeStatBlock | undefined = undefined;
    if (statStart === ';') {
        parser.commit(HighlightToken.Operator);
    } else {
        statBlock = expectStatBlock(parser);
    }

    if (statBlock === undefined) statBlock = {
        nodeName: NodeName.StatBlock,
        nodeRange: {start: parser.next(), end: parser.next()},
        statementList: []
    };

    return {
        nodeName: NodeName.Func,
        nodeRange: {start: rangeStart, end: parser.prev()},
        entity: entityAttribute,
        accessor: accessor,
        head: head,
        identifier: identifier,
        typeTemplates: typeTemplates,
        paramList: paramList,
        isConst: isConst,
        funcAttr: funcAttr,
        statBlock: statBlock
    };
}

function parseConst(parser: ParserState): boolean {
    if (parser.next().text !== 'const') return false;
    parser.commit(HighlightToken.Keyword);
    return true;
}

function parseRef(parser: ParserState) {
    const isRef = parser.next().text === '&';
    if (isRef) parser.commit(HighlightToken.Builtin);
    return isRef;
}

// Metadata declarations in the same place and the only other rule is the matching count of '[' and ']'
// eg. '[Hello[]]' is ok but '[Hello[]' is not.
function parseMetadata(parser: ParserState): TokenObject[] {
    const rangeStart = parser.next();
    if (parser.next().text !== '[') return [];

    let level = 0;

    let metadata: TokenObject[] = [];
    while (parser.isEnd() === false) {
        if (parser.next().text === '[') {
            if (level > 0) metadata.push(parser.next());

            level++;
            parser.commit(HighlightToken.Operator);
        } else if (parser.next().text === ']') {
            level--;
            parser.commit(HighlightToken.Operator);

            if (level === 0) {
                // Since AngelScript supports multiple metadata declarations in subsequent pairs of '[' and ']', we recursively parse those declarations here.
                // eg. '[Hello][World]' is valid, as is
                // [Hello]
                // [World]
                if (parser.next().text === '[') {
                    metadata = [...metadata, ...parseMetadata(parser)];
                }

                return metadata;
            } else metadata.push(parser.next());
        } else {
            metadata.push(parser.next());
            parser.commit(HighlightToken.Decorator);
        }
    }

    // when level !== 0
    parser.backtrack(rangeStart);
    return [];
}

// ['private' | 'protected']
function parseAccessModifier(parser: ParserState): AccessModifier | undefined {
    const next = parser.next().text;
    if (next === 'private' || next === 'protected') {
        parser.commit(HighlightToken.Builtin);
        return next === 'private' ? AccessModifier.Private : AccessModifier.Protected;
    }
    return undefined;
}

// INTERFACE     ::= {'external' | 'shared'} 'interface' IDENTIFIER (';' | ([':' IDENTIFIER {',' IDENTIFIER}] '{' {VIRTPROP | INTFMTHD} '}'))
function parseInterface(parser: ParserState): ParsedResult<NodeInterface> {
    const rangeStart = parser.next();

    const entity = parseEntityAttribute(parser);

    if (parser.next().text !== 'interface') {
        parser.backtrack(rangeStart);
        return ParseFailure.Mismatch;
    }
    parser.commit(HighlightToken.Builtin);

    const identifier = expectIdentifier(parser, HighlightToken.Interface);
    if (identifier === undefined) return ParseFailure.Pending;

    const result: Mutable<NodeInterface> = {
        nodeName: NodeName.Interface,
        nodeRange: {start: rangeStart, end: parser.prev()},
        entity: entity,
        identifier: identifier,
        baseList: [],
        memberList: []
    };

    if (parser.next().text === ';') {
        parser.commit(HighlightToken.Operator);
        return result;
    }

    if (parser.next().text === ':') {
        parser.commit(HighlightToken.Operator);
        while (parser.isEnd() === false) {
            const identifier = expectIdentifier(parser, HighlightToken.Type);
            if (identifier !== undefined) result.baseList.push(identifier);

            if (expectContinuousOrClose(parser, ',', '{', true) === BreakOrThrough.Break) break;

            if (identifier === undefined) parser.step();
        }
    } else {
        parser.expect('{', HighlightToken.Operator);
    }

    result.memberList = expectInterfaceMembers(parser);

    return result;
}

// '{' {VIRTPROP | INTFMTHD} '}'
function expectInterfaceMembers(parser: ParserState): (NodeIntfMethod | NodeVirtualProp)[] {
    // parser.expect('{', HighlightTokenKind.Operator);

    const members: (NodeIntfMethod | NodeVirtualProp)[] = [];
    while (parser.isEnd() === false) {
        if (parseCloseOperator(parser, '}') === BreakOrThrough.Break) break;

        const intfMethod = parseIntfMethod(parser);
        if (intfMethod !== undefined) {
            members.push(intfMethod);
            continue;
        }

        const virtualProp = parseVirtualProp(parser);
        if (virtualProp !== undefined) {
            members.push(virtualProp);
            continue;
        }

        parser.error("Expected interface member.");
        parser.step();
    }
    return members;
}

// VAR           ::= ['private' | 'protected'] TYPE IDENTIFIER [( '=' (INITLIST | ASSIGN)) | ARGLIST] {',' IDENTIFIER [( '=' (INITLIST | ASSIGN)) | ARGLIST]} ';'
function parseVar(parser: ParserState): NodeVar | undefined {
    const rangeStart = parser.next();

    parseMetadata(parser);

    const accessor = parseAccessModifier(parser);

    const type = parseType(parser);
    if (type === undefined) {
        parser.backtrack(rangeStart);
        return undefined;
    }

    if (parser.next().kind !== TokenKind.Identifier) {
        parser.backtrack(rangeStart);
        return undefined;
    }

    const variables: ParsedVariableInit[] = [];
    while (parser.isEnd() === false) {
        // 識別子
        const identifier = expectIdentifier(parser, HighlightToken.Variable);
        if (identifier === undefined) break;

        // 初期化子
        if (parser.next().text === '=') {
            parser.commit(HighlightToken.Operator);

            const initListOrExpr = expectInitListOrExpr(parser);
            variables.push({identifier: identifier, initializer: initListOrExpr});
        } else {
            const argList = parseArgList(parser);
            variables.push({identifier: identifier, initializer: argList});
        }

        // 追加または終了判定
        if (expectContinuousOrClose(parser, ',', ';', true) === BreakOrThrough.Break) break;
    }

    return {
        nodeName: NodeName.Var,
        nodeRange: {start: rangeStart, end: parser.prev()},
        accessor: accessor,
        type: type,
        variables: variables
    };
}

function expectInitListOrExpr(parser: ParserState) {
    const initList = parseInitList(parser);
    if (initList !== undefined) {
        return initList;
    }

    const expr = expectAssign(parser);
    if (expr !== undefined) {
        return expr;
    }

    parser.error("Expected initializer list or assignment.");
}

// IMPORT        ::= 'import' TYPE ['&'] IDENTIFIER PARAMLIST FUNCATTR 'from' STRING ';'
function parseImport(parser: ParserState): ParsedResult<NodeImport> {
    const rangeStart = parser.next();

    if (parser.next().text !== 'import') return ParseFailure.Mismatch;
    parser.commit(HighlightToken.Keyword);

    const type = expectType(parser);
    if (type === undefined) return ParseFailure.Pending;

    const isRef = parseRef(parser);

    const identifier = expectIdentifier(parser, HighlightToken.Variable);
    if (identifier === undefined) return ParseFailure.Pending;

    const paramList = expectParamList(parser);
    if (paramList === undefined) return ParseFailure.Pending;

    const funcAttr = parseFuncAttr(parser);

    if (expectContextualKeyword(parser, 'from') === false) return ParseFailure.Pending;

    const path = parser.next();
    if (path.kind !== TokenKind.String) {
        parser.error("Expected string path.");
        return ParseFailure.Pending;
    }
    parser.commit(HighlightToken.String);

    parser.expect(';', HighlightToken.Operator);

    return {
        nodeName: NodeName.Import,
        nodeRange: {start: rangeStart, end: parser.prev()},
        type: type,
        isRef: isRef,
        identifier: identifier,
        paramList: paramList,
        funcAttr: funcAttr,
        path: path
    };
}

// FUNCDEF       ::= {'external' | 'shared'} 'funcdef' TYPE ['&'] IDENTIFIER PARAMLIST ';'
function parseFuncDef(parser: ParserState): ParsedResult<NodeFuncDef> {
    const rangeStart = parser.next();

    const entity = parseEntityAttribute(parser);

    if (parser.next().text !== 'funcdef') {
        parser.backtrack(rangeStart);
        return ParseFailure.Mismatch;
    }
    parser.commit(HighlightToken.Builtin);

    const returnType = expectType(parser);
    if (returnType === undefined) return ParseFailure.Pending;

    const isRef = parseRef(parser);

    const identifier = parser.next();
    parser.commit(HighlightToken.Function);

    const paramList = expectParamList(parser);
    if (paramList === undefined) return ParseFailure.Pending;

    parser.expect(';', HighlightToken.Operator);

    return {
        nodeName: NodeName.FuncDef,
        nodeRange: {start: rangeStart, end: parser.prev()},
        entity: entity,
        returnType: returnType,
        isRef: isRef,
        identifier: identifier,
        paramList: paramList
    };
}

// VIRTPROP      ::= ['private' | 'protected'] TYPE ['&'] IDENTIFIER '{' {('get' | 'set') ['const'] FUNCATTR (STATBLOCK | ';')} '}'
function parseVirtualProp(parser: ParserState): NodeVirtualProp | undefined {
    const rangeStart = parser.next();

    parseMetadata(parser);

    const accessor = parseAccessModifier(parser);

    const type = parseType(parser);
    if (type === undefined) {
        parser.backtrack(rangeStart);
        return undefined;
    }

    const isRef = parseRef(parser);

    const identifier = parseIdentifier(parser, HighlightToken.Variable);
    if (identifier === undefined) {
        parser.backtrack(rangeStart);
        return undefined;
    }

    if (parser.next().text !== '{') {
        parser.backtrack(rangeStart);
        return undefined;
    }
    parser.commit(HighlightToken.Operator);

    let getter: ParsedGetterSetter | undefined = undefined;
    let setter: ParsedGetterSetter | undefined = undefined;
    while (parser.isEnd() === false) {
        const next = parser.next().text;
        if (parseCloseOperator(parser, '}') === BreakOrThrough.Break) break;
        else if (next === 'get') getter = expectGetterSetter(parser);
        else if (next === 'set') setter = expectGetterSetter(parser);
        else {
            parser.error("Expected getter or setter.");
            parser.step();
        }
    }

    return {
        nodeName: NodeName.VirtualProp,
        nodeRange: {start: rangeStart, end: parser.prev()},
        accessor: accessor,
        type: type,
        isRef: isRef,
        identifier: identifier,
        getter: getter,
        setter: setter
    };
}

// ('get' | 'set') ['const'] FUNCATTR (STATBLOCK | ';')
function expectGetterSetter(parser: ParserState): ParsedGetterSetter {
    parser.commit(HighlightToken.Builtin);

    const isConst = parseConst(parser);
    const funcAttr = parseFuncAttr(parser);
    const statBlock = expectStatBlock(parser);

    return {
        isConst: isConst,
        funcAttr: funcAttr,
        statBlock: statBlock
    };
}

// MIXIN         ::= 'mixin' CLASS
function parseMixin(parser: ParserState): ParsedResult<NodeMixin> {
    if (parser.next().text !== 'mixin') return ParseFailure.Mismatch;
    const rangeStart = parser.next();
    parser.commit(HighlightToken.Builtin);

    const parsedClass = parseClass(parser);
    if (parsedClass === ParseFailure.Pending) return ParseFailure.Pending;
    if (parsedClass === ParseFailure.Mismatch) {
        parser.error("Expected class definition.");
        return ParseFailure.Pending;
    }

    return {
        nodeName: NodeName.Mixin,
        nodeRange: {start: rangeStart, end: parser.prev()},
        mixinClass: parsedClass
    };
}

// INTFMTHD      ::= TYPE ['&'] IDENTIFIER PARAMLIST ['const'] ';'
function parseIntfMethod(parser: ParserState): NodeIntfMethod | undefined {
    const rangeStart = parser.next();

    const returnType = expectType(parser);
    if (returnType === undefined) return undefined;

    const isRef = parseRef(parser);

    const identifier = parseIdentifier(parser, HighlightToken.Function);
    if (identifier === undefined) return undefined;

    const paramList = parseParamList(parser);
    if (paramList === undefined) return undefined;

    const isConst = parseConst(parser);

    parser.expect(';', HighlightToken.Operator);

    return {
        nodeName: NodeName.IntfMethod,
        nodeRange: {start: rangeStart, end: parser.prev()},
        returnType: returnType,
        isRef: isRef,
        identifier: identifier,
        paramList: paramList,
        isConst: isConst
    };
}

// STATBLOCK     ::= '{' {VAR | STATEMENT} '}'
function parseStatBlock(parser: ParserState): NodeStatBlock | undefined {
    if (parser.next().text !== '{') return undefined;
    const rangeStart = parser.next();
    parser.commit(HighlightToken.Operator);

    const statementList: (NodeVar | NodeStatement)[] = [];
    while (parser.isEnd() === false) {
        if (parseCloseOperator(parser, '}') === BreakOrThrough.Break) break;

        const parsedVar = parseVar(parser);
        if (parsedVar !== undefined) {
            statementList.push(parsedVar);
            continue;
        }

        const statement = parseStatement(parser);
        if (statement === ParseFailure.Pending) continue;
        if (statement !== ParseFailure.Mismatch) {
            statementList.push(statement);
            continue;
        }

        parser.error("Expected statement.");
        parser.step();
    }

    return {
        nodeName: NodeName.StatBlock,
        nodeRange: {start: rangeStart, end: parser.prev()},
        statementList: statementList
    };
}

function expectStatBlock(parser: ParserState): NodeStatBlock | undefined {
    const statBlock = parseStatBlock(parser);
    if (statBlock === undefined) {
        parser.error("Expected statement block.");
    }
    return statBlock;
}

// PARAMLIST     ::= '(' ['void' | (TYPE TYPEMOD [IDENTIFIER] ['=' EXPR] {',' TYPE TYPEMOD [IDENTIFIER] ['=' EXPR]})] ')'
function parseParamList(parser: ParserState): NodeParamList | undefined {
    if (parser.next().text !== '(') return undefined;
    parser.commit(HighlightToken.Operator);

    if (parser.next().text === 'void') {
        parser.commit(HighlightToken.Builtin);
        parser.expect(')', HighlightToken.Operator);
        return [];
    }

    const paramList: NodeParamList = [];
    while (parser.isEnd() === false) {
        if (expectCommaOrParensClose(parser, paramList.length > 0) === BreakOrThrough.Break) break;

        const type = expectType(parser);
        if (type === undefined) {
            parser.step();
            continue;
        }

        const typeMod = parseTypeMod(parser);

        let identifier: TokenObject | undefined = undefined;
        if (parser.next().kind === TokenKind.Identifier) {
            identifier = parser.next();
            parser.commit(HighlightToken.Variable);
        }

        let defaultExpr: NodeExpr | undefined = undefined;
        if (parser.next().text === '=') {
            parser.commit(HighlightToken.Operator);
            defaultExpr = expectExpr(parser);
        }
        paramList.push({type: type, modifier: typeMod, identifier: identifier, defaultExpr: defaultExpr});
    }

    return paramList;
}

function expectParamList(parser: ParserState): NodeParamList | undefined {
    const paramList = parseParamList(parser);
    if (paramList === undefined) {
        parser.error("Expected parameter list.");
    }
    return paramList;
}

function expectCommaOrParensClose(parser: ParserState, canColon: boolean): BreakOrThrough {
    return expectContinuousOrClose(parser, ',', ')', canColon);
}

function isCommaOrParensClose(character: string): boolean {
    return character === ',' || character === ')';
}

function parseContinuousOrClose(
    parser: ParserState, continuousOp: string, closeOp: string, canColon: boolean
): BreakOrThrough | undefined {
    const next = parser.next().text;
    if (next === closeOp) {
        parser.commit(HighlightToken.Operator);
        return BreakOrThrough.Break;
    } else if (canColon) {
        if (next !== continuousOp) return undefined;
        parser.commit(HighlightToken.Operator);
    }
    return BreakOrThrough.Through;
}

function expectContinuousOrClose(
    parser: ParserState, continuousOp: string, closeOp: string, canColon: boolean
): BreakOrThrough {
    const parsed = parseContinuousOrClose(parser, continuousOp, closeOp, canColon);
    if (parsed !== undefined) return parsed;

    parser.error(`Expected '${continuousOp}' or '${closeOp}'.`);
    return BreakOrThrough.Break;
}

function parseCloseOperator(parser: ParserState, closeOp: string): BreakOrThrough {
    const next = parser.next().text;
    if (next === closeOp) {
        parser.commit(HighlightToken.Operator);
        return BreakOrThrough.Break;
    }
    return BreakOrThrough.Through;
}

// TYPEMOD       ::= ['&' ['in' | 'out' | 'inout']]
function parseTypeMod(parser: ParserState): TypeModifier | undefined {
    if (parser.next().text !== '&') return undefined;
    parser.commit(HighlightToken.Builtin);

    const next = parser.next().text;
    if (next === 'in' || next === 'out' || next === 'inout') {
        parser.commit(HighlightToken.Builtin);
        if (next === 'in') return TypeModifier.In;
        if (next === 'out') return TypeModifier.Out;
    }
    return TypeModifier.InOut;
}

// TYPE          ::= ['const'] SCOPE DATATYPE ['<' TYPE {',' TYPE} '>'] { ('[' ']') | ('@' ['const']) }
function parseType(parser: ParserState): NodeType | undefined {
    const rangeStart = parser.next();

    const isConst = parseConst(parser);

    const scope = parseScope(parser);

    const datatype = parseDatatype(parser);
    if (datatype === undefined) {
        parser.backtrack(rangeStart);
        return undefined;
    }

    const typeTemplates = parseTypeTemplates(parser) ?? [];

    const {isArray, refModifier} = parseTypeTail(parser);

    return {
        nodeName: NodeName.Type,
        nodeRange: {start: rangeStart, end: parser.prev()},
        isConst: isConst,
        scope: scope,
        dataType: datatype,
        typeTemplates: typeTemplates,
        isArray: isArray,
        refModifier: refModifier
    };
}

function parseTypeTail(parser: ParserState) {
    let isArray = false;
    let refModifier: ReferenceModifier | undefined = undefined;
    while (parser.isEnd() === false) {
        if (parser.next(0).text === '[' && parser.next(1).text === ']') {
            parser.commit(HighlightToken.Operator);
            parser.commit(HighlightToken.Operator);
            isArray = true;
            continue;
        } else if (parser.next().text === '@') {
            parser.commit(HighlightToken.Builtin);
            if (parser.next().text === 'const') {
                parser.commit(HighlightToken.Builtin);
                refModifier = ReferenceModifier.AtConst;
            } else {
                refModifier = ReferenceModifier.At;
            }
            continue;
        }
        break;
    }
    return {isArray, refModifier};
}

function expectType(parser: ParserState): NodeType | undefined {
    const type = parseType(parser);
    if (type === undefined) {
        parser.error("Expected type.");
    }
    return type;
}

// '<' TYPE {',' TYPE} '>'
function parseTypeTemplates(parser: ParserState): NodeType[] | undefined {
    const cache = parser.cache(ParsedCacheKind.TypeTemplates);
    if (cache.restore !== undefined) return cache.restore();

    const rangeStart = parser.next();
    if (parser.next().text !== '<') return undefined;
    parser.commit(HighlightToken.Operator);

    const typeTemplates: NodeType[] = [];
    while (parser.isEnd() === false) {
        const type = parseType(parser);
        if (type === undefined) {
            parser.backtrack(rangeStart);
            return undefined;
        }

        typeTemplates.push(type);

        const continuous = parseContinuousOrClose(parser, ',', '>', typeTemplates.length > 0);
        if (continuous === BreakOrThrough.Break) break;
        else if (continuous === undefined) {
            parser.backtrack(rangeStart);
            cache.store(undefined);
            return undefined;
        }
    }

    cache.store(typeTemplates);
    return typeTemplates;
}

// INITLIST      ::= '{' [ASSIGN | INITLIST] {',' [ASSIGN | INITLIST]} '}'
function parseInitList(parser: ParserState): NodeInitList | undefined {
    if (parser.next().text !== '{') return undefined;
    const rangeStart = parser.next();
    parser.commit(HighlightToken.Operator);

    const initList: (NodeAssign | NodeInitList)[] = [];
    while (parser.isEnd() === false) {
        if (expectContinuousOrClose(parser, ',', '}', initList.length > 0) === BreakOrThrough.Break) break;

        const assign = parseAssign(parser);
        if (assign !== undefined) {
            initList.push(assign);
            continue;
        }

        const parsedInits = parseInitList(parser);
        if (parsedInits !== undefined) {
            initList.push(parsedInits);
            continue;
        }

        parser.error("Expected assignment or initializer list.");
        parser.step();
    }
    return {
        nodeName: NodeName.InitList,
        nodeRange: {start: rangeStart, end: parser.prev()},
        initList: initList
    };
}

// SCOPE         ::= ['::'] {IDENTIFIER '::'} [IDENTIFIER ['<' TYPE {',' TYPE} '>'] '::']
function parseScope(parser: ParserState): NodeScope | undefined {
    const cache = parser.cache(ParsedCacheKind.Scope);
    if (cache.restore !== undefined) return cache.restore();

    const rangeStart = parser.next();

    let isGlobal = false;
    if (parser.next().text === '::') {
        parser.commit(HighlightToken.Operator);
        isGlobal = true;
    }

    const scopeList: TokenObject[] = [];
    let typeTemplates: NodeType[] | undefined = undefined;
    while (parser.isEnd() === false) {
        const identifier = parser.next(0);
        if (identifier.kind !== TokenKind.Identifier) {
            break;
        }

        if (parser.next(1).text === '::') {
            parser.commit(HighlightToken.Namespace);
            parser.commit(HighlightToken.Operator);
            scopeList.push(identifier);
            continue;
        } else if (parser.next(1).text === '<') {
            const typesStart = parser.next();
            parser.commit(HighlightToken.Class);

            typeTemplates = parseTypeTemplates(parser);
            if (typeTemplates === undefined || parser.next().text !== '::') {
                parser.backtrack(typesStart);
            } else {
                parser.commit(HighlightToken.Operator);
                scopeList.push(identifier);
            }
        }
        break;
    }

    if (isGlobal === false && scopeList.length === 0) {
        cache.store(undefined);
        return undefined;
    }

    const nodeScope: NodeScope = {
        nodeName: NodeName.Scope,
        nodeRange: {start: rangeStart, end: parser.prev()},
        isGlobal: isGlobal,
        scopeList: scopeList,
        typeTemplates: typeTemplates ?? []
    };
    cache.store(nodeScope);
    return nodeScope;
}

// DATATYPE      ::= (IDENTIFIER | PRIMTYPE | '?' | 'auto')
function parseDatatype(parser: ParserState): NodeDataType | undefined {
    const next = parser.next();
    if (next.kind === TokenKind.Identifier) {
        parser.commit(HighlightToken.Type);
        return {
            nodeName: NodeName.DataType,
            nodeRange: {start: next, end: next},
            identifier: next
        };
    }

    if (next.text === '?' || next.text === 'auto') {
        parser.commit(HighlightToken.Builtin);
        return {
            nodeName: NodeName.DataType,
            nodeRange: {start: next, end: next},
            identifier: next
        };
    }

    const primType = parsePrimeType(parser);
    if (primType !== undefined) return {
        nodeName: NodeName.DataType,
        nodeRange: {start: next, end: next},
        identifier: primType
    };

    return undefined;
}

// PRIMTYPE      ::= 'void' | 'int' | 'int8' | 'int16' | 'int32' | 'int64' | 'uint' | 'uint8' | 'uint16' | 'uint32' | 'uint64' | 'float' | 'double' | 'bool'
function parsePrimeType(parser: ParserState) {
    const next = parser.next();
    if (next.isReservedToken() === false || next.property.isPrimeType === false) return undefined;
    parser.commit(HighlightToken.Builtin);
    return next;
}

// FUNCATTR      ::= {'override' | 'final' | 'explicit' | 'property'}
function parseFuncAttr(parser: ParserState): FunctionAttribute | undefined {
    let attribute: FunctionAttribute | undefined = undefined;
    while (parser.isEnd() === false) {
        const next = parser.next().text;
        const isFuncAttrToken = next === 'override' || next === 'final' || next === 'explicit' || next === 'property';
        if (isFuncAttrToken === false) break;
        if (attribute === undefined) attribute = {
            isOverride: false,
            isFinal: false,
            isExplicit: false,
            isProperty: false
        };
        setFunctionAttribute(attribute, next);
        parser.commit(HighlightToken.Builtin);
    }
    return attribute;
}

// STATEMENT     ::= (IF | FOR | WHILE | RETURN | STATBLOCK | BREAK | CONTINUE | DOWHILE | SWITCH | EXPRSTAT | TRY)
function parseStatement(parser: ParserState): ParsedResult<NodeStatement> {
    const parsedIf = parseIf(parser);
    if (parsedIf === ParseFailure.Pending) return ParseFailure.Pending;
    if (parsedIf !== ParseFailure.Mismatch) return parsedIf;

    const parsedFor = parseFor(parser);
    if (parsedFor === ParseFailure.Pending) return ParseFailure.Pending;
    if (parsedFor !== ParseFailure.Mismatch) return parsedFor;

    const parsedWhile = parseWhile(parser);
    if (parsedWhile === ParseFailure.Pending) return ParseFailure.Pending;
    if (parsedWhile !== ParseFailure.Mismatch) return parsedWhile;

    const parsedReturn = parseReturn(parser);
    if (parsedReturn === ParseFailure.Pending) return ParseFailure.Pending;
    if (parsedReturn !== ParseFailure.Mismatch) return parsedReturn;

    const statBlock = parseStatBlock(parser);
    if (statBlock !== undefined) return statBlock;

    const parsedBreak = parseBreak(parser);
    if (parsedBreak !== undefined) return parsedBreak;

    const parsedContinue = parseContinue(parser);
    if (parsedContinue !== undefined) return parsedContinue;

    const doWhile = parseDoWhile(parser);
    if (doWhile === ParseFailure.Pending) return ParseFailure.Pending;
    if (doWhile !== ParseFailure.Mismatch) return doWhile;

    const parsedSwitch = parseSwitch(parser);
    if (parsedSwitch === ParseFailure.Pending) return ParseFailure.Pending;
    if (parsedSwitch !== ParseFailure.Mismatch) return parsedSwitch;

    const parsedTry = parseTry(parser);
    if (parsedTry === ParseFailure.Pending) return ParseFailure.Pending;
    if (parsedTry !== ParseFailure.Mismatch) return parsedTry;

    const exprStat = parseExprStat(parser);
    if (exprStat !== undefined) return exprStat;

    return ParseFailure.Mismatch;
}

function expectStatement(parser: ParserState): NodeStatement | undefined {
    const statement = parseStatement(parser);
    if (statement === ParseFailure.Pending) return undefined;
    if (statement === ParseFailure.Mismatch) {
        parser.error("Expected statement.");
        return undefined;
    }
    return statement;
}

// SWITCH        ::= 'switch' '(' ASSIGN ')' '{' {CASE} '}'
function parseSwitch(parser: ParserState): ParsedResult<NodeSwitch> {
    if (parser.next().text !== 'switch') return ParseFailure.Mismatch;
    const rangeStart = parser.next();
    parser.commit(HighlightToken.Keyword);

    parser.expect('(', HighlightToken.Operator);

    const assign = expectAssign(parser);
    if (assign === undefined) return ParseFailure.Pending;

    parser.expect(')', HighlightToken.Operator);
    parser.expect('{', HighlightToken.Operator);

    const cases: NodeCase[] = [];
    while (parser.isEnd() === false) {
        if (parseCloseOperator(parser, '}') === BreakOrThrough.Break) break;

        const parsedCase = parseCase(parser);
        if (parsedCase === ParseFailure.Mismatch) {
            parser.error("Expected case statement.");
            parser.step();
            continue;
        }
        if (parsedCase === ParseFailure.Pending) continue;
        cases.push(parsedCase);
    }

    return {
        nodeName: NodeName.Switch,
        nodeRange: {start: rangeStart, end: parser.prev()},
        assign: assign,
        caseList: cases
    };
}

// BREAK         ::= 'break' ';'
function parseBreak(parser: ParserState): NodeBreak | undefined {
    if (parser.next().text !== 'break') return undefined;
    const rangeStart = parser.next();
    parser.commit(HighlightToken.Keyword);

    parser.expect(';', HighlightToken.Operator);
    return {nodeName: NodeName.Break, nodeRange: {start: rangeStart, end: parser.prev()}};
}

// FOR           ::= 'for' '(' (VAR | EXPRSTAT) EXPRSTAT [ASSIGN {',' ASSIGN}] ')' STATEMENT
function parseFor(parser: ParserState): ParsedResult<NodeFor> {
    if (parser.next().text !== 'for') return ParseFailure.Mismatch;
    const rangeStart = parser.next();
    parser.commit(HighlightToken.Keyword);

    if (parser.expect('(', HighlightToken.Operator) === false) return ParseFailure.Pending;

    const initial: NodeExprStat | NodeVar | undefined = parseVar(parser) ?? parseExprStat(parser);
    if (initial === undefined) {
        parser.error("Expected initial expression statement or variable declaration.");
        return ParseFailure.Pending;
    }

    const result: Mutable<NodeFor> = {
        nodeName: NodeName.For,
        nodeRange: {start: rangeStart, end: parser.prev()},
        initial: initial,
        condition: undefined,
        incrementList: [],
        statement: undefined
    };

    result.condition = expectExprStat(parser);
    if (result.condition === undefined) return appliedNodeEnd(parser, result);

    while (parser.isEnd() === false) {
        if (expectContinuousOrClose(parser, ',', ')', result.incrementList.length > 0) === BreakOrThrough.Break) break;

        const assign = expectAssign(parser);
        if (assign === undefined) break;

        result.incrementList.push(assign);
    }

    result.statement = expectStatement(parser);
    return appliedNodeEnd(parser, result);
}

// WHILE         ::= 'while' '(' ASSIGN ')' STATEMENT
function parseWhile(parser: ParserState): ParsedResult<NodeWhile> {
    if (parser.next().text !== 'while') return ParseFailure.Mismatch;
    const rangeStart = parser.next();
    parser.commit(HighlightToken.Keyword);

    if (parser.expect('(', HighlightToken.Operator) === false) return ParseFailure.Pending;

    const assign = expectAssign(parser);
    if (assign === undefined) return ParseFailure.Pending;

    const result: Mutable<NodeWhile> = {
        nodeName: NodeName.While,
        nodeRange: {start: rangeStart, end: parser.prev()},
        assign: assign,
        statement: undefined
    };

    if (parser.expect(')', HighlightToken.Operator) === false) return appliedNodeEnd(parser, result);

    result.statement = expectStatement(parser);
    return appliedNodeEnd(parser, result);
}

// DOWHILE       ::= 'do' STATEMENT 'while' '(' ASSIGN ')' ';'
function parseDoWhile(parser: ParserState): ParsedResult<NodeDoWhile> {
    if (parser.next().text !== 'do') return ParseFailure.Mismatch;
    const rangeStart = parser.next();
    parser.commit(HighlightToken.Keyword);

    const statement = expectStatement(parser);
    if (statement === undefined) return ParseFailure.Pending;

    const result: Mutable<NodeDoWhile> = {
        nodeName: NodeName.DoWhile,
        nodeRange: {start: rangeStart, end: parser.prev()},
        statement: statement,
        assign: undefined
    };

    if (parser.expect('while', HighlightToken.Keyword) === false) return appliedNodeEnd(parser, result);
    if (parser.expect('(', HighlightToken.Operator) === false) return appliedNodeEnd(parser, result);

    result.assign = expectAssign(parser);
    if (result.assign === undefined) return appliedNodeEnd(parser, result);

    if (parser.expect(')', HighlightToken.Operator) === false) return appliedNodeEnd(parser, result);

    parser.expect(';', HighlightToken.Operator);
    return appliedNodeEnd(parser, result);
}

// IF            ::= 'if' '(' ASSIGN ')' STATEMENT ['else' STATEMENT]
function parseIf(parser: ParserState): ParsedResult<NodeIf> {
    if (parser.next().text !== 'if') return ParseFailure.Mismatch;
    const rangeStart = parser.next();
    parser.commit(HighlightToken.Keyword);

    if (parser.expect('(', HighlightToken.Operator) === false) return ParseFailure.Pending;

    const assign = expectAssign(parser);
    if (assign === undefined) return ParseFailure.Pending;

    const result: Mutable<NodeIf> = {
        nodeName: NodeName.If,
        nodeRange: {start: rangeStart, end: parser.prev()},
        condition: assign,
        thenStat: undefined,
        elseStat: undefined
    };

    if (parser.expect(')', HighlightToken.Operator) === false) return appliedNodeEnd(parser, result);

    result.thenStat = expectStatement(parser);
    if (result.thenStat === undefined) return appliedNodeEnd(parser, result);

    if (parser.next().text === 'else') {
        parser.commit(HighlightToken.Keyword);

        result.elseStat = expectStatement(parser);
    }

    return appliedNodeEnd(parser, result);
}

function appliedNodeEnd<T extends NodesBase>(parser: ParserState, node: Mutable<T>): T {
    node.nodeRange = makeParsedRange(node.nodeRange.start, parser.prev());
    return node;
}

// CONTINUE      ::= 'continue' ';'
function parseContinue(parser: ParserState): NodeContinue | undefined {
    if (parser.next().text !== 'continue') return undefined;
    const rangeStart = parser.next();
    parser.commit(HighlightToken.Keyword);
    parser.expect(';', HighlightToken.Operator);
    return {nodeName: NodeName.Continue, nodeRange: {start: rangeStart, end: parser.prev()}};
}

// EXPRSTAT      ::= [ASSIGN] ';'
function parseExprStat(parser: ParserState): NodeExprStat | undefined {
    const rangeStart = parser.next();
    if (parser.next().text === ';') {
        parser.commit(HighlightToken.Operator);
        return {
            nodeName: NodeName.ExprStat,
            nodeRange: {start: rangeStart, end: parser.prev()},
            assign: undefined
        };
    }

    const assign = parseAssign(parser);
    if (assign === undefined) return undefined;

    parser.expect(';', HighlightToken.Operator);

    return {
        nodeName: NodeName.ExprStat,
        nodeRange: {start: rangeStart, end: parser.prev()},
        assign: assign
    };
}

function expectExprStat(parser: ParserState): NodeExprStat | undefined {
    const exprStat = parseExprStat(parser);
    if (exprStat === undefined) {
        parser.error("Expected expression statement.");
    }
    return exprStat;
}

// TRY           ::= 'try' STATBLOCK 'catch' STATBLOCK
function parseTry(parser: ParserState): ParsedResult<NodeTry> {
    if (parser.next().text !== 'try') return ParseFailure.Mismatch;
    const rangeStart = parser.next();
    parser.commit(HighlightToken.Keyword);

    const tryBlock = expectStatBlock(parser);
    if (tryBlock === undefined) return ParseFailure.Pending;

    const result: Mutable<NodeTry> = {
        nodeName: NodeName.Try,
        nodeRange: {start: rangeStart, end: parser.prev()},
        tryBlock: tryBlock,
        catchBlock: undefined
    };

    if (parser.expect('catch', HighlightToken.Keyword) === false) return appliedNodeEnd(parser, result);

    result.catchBlock = expectStatBlock(parser);
    return appliedNodeEnd(parser, result);
}

// RETURN        ::= 'return' [ASSIGN] ';'
function parseReturn(parser: ParserState): ParsedResult<NodeReturn> {
    if (parser.next().text !== 'return') return ParseFailure.Mismatch;
    const rangeStart = parser.next();
    parser.commit(HighlightToken.Keyword);

    const result: Mutable<NodeReturn> = {
        nodeName: NodeName.Return,
        nodeRange: {start: rangeStart, end: parser.prev()},
        assign: undefined
    };

    if (parser.next().text === ';') {
        parser.commit(HighlightToken.Operator);
        return appliedNodeEnd(parser, result);
    }

    result.assign = expectAssign(parser);
    if (result.assign === undefined) return appliedNodeEnd(parser, result);

    parser.expect(';', HighlightToken.Operator);
    return appliedNodeEnd(parser, result);
}

// CASE          ::= (('case' EXPR) | 'default') ':' {STATEMENT}
function parseCase(parser: ParserState): ParsedResult<NodeCase> {
    const rangeStart = parser.next();

    let expr = undefined;
    if (parser.next().text === 'case') {
        parser.commit(HighlightToken.Keyword);

        expr = expectExpr(parser);
        if (expr === undefined) return ParseFailure.Pending;
    } else if (parser.next().text === 'default') {
        parser.commit(HighlightToken.Keyword);
    } else {
        return ParseFailure.Mismatch;
    }

    parser.expect(':', HighlightToken.Operator);

    const statements: NodeStatement[] = [];
    while (parser.isEnd() === false) {
        const statement = parseStatement(parser);
        if (statement === ParseFailure.Mismatch) break;
        if (statement === ParseFailure.Pending) continue;
        statements.push(statement);
    }

    return {
        nodeName: NodeName.Case,
        nodeRange: {start: rangeStart, end: parser.prev()},
        expr: expr,
        statementList: statements
    };
}

// EXPR          ::= EXPRTERM {EXPROP EXPRTERM}
function parseExpr(parser: ParserState): NodeExpr | undefined {
    const rangeStart = parser.next();

    const exprTerm = parseExprTerm(parser);
    if (exprTerm === undefined) return undefined;

    const exprOp = parseExprOp(parser);
    if (exprOp === undefined) return {
        nodeName: NodeName.Expr,
        nodeRange: {start: rangeStart, end: parser.prev()},
        head: exprTerm,
        tail: undefined
    };

    const tail = expectExpr(parser);
    if (tail === undefined) return {
        nodeName: NodeName.Expr,
        nodeRange: {start: rangeStart, end: parser.prev()},
        head: exprTerm,
        tail: undefined
    };

    return {
        nodeName: NodeName.Expr,
        nodeRange: {start: rangeStart, end: parser.prev()},
        head: exprTerm,
        tail: {
            operator: exprOp,
            expression: tail
        }
    };
}

function expectExpr(parser: ParserState): NodeExpr | undefined {
    const expr = parseExpr(parser);
    if (expr === undefined) {
        parser.error("Expected expression.");
    }
    return expr;
}

// EXPRTERM      ::= ([TYPE '='] INITLIST) | ({EXPRPREOP} EXPRVALUE {EXPRPOSTOP})
function parseExprTerm(parser: ParserState) {
    const exprTerm1 = parseExprTerm1(parser);
    if (exprTerm1 !== undefined) return exprTerm1;

    const exprTerm2 = parseExprTerm2(parser);
    if (exprTerm2 !== undefined) return exprTerm2;

    return undefined;
}

// ([TYPE '='] INITLIST)
function parseExprTerm1(parser: ParserState): NodeExprTerm1 | undefined {
    const rangeStart = parser.next();

    const type = parseType(parser);
    if (type !== undefined) {
        if (parser.next().text !== '=') {
            parser.backtrack(rangeStart);
            return undefined;
        }
        parser.commit(HighlightToken.Operator);
    }

    const initList = parseInitList(parser);
    if (initList === undefined) {
        parser.backtrack(rangeStart);
        return undefined;
    }

    return {
        nodeName: NodeName.ExprTerm,
        nodeRange: {start: rangeStart, end: parser.prev()},
        exprTerm: 1,
        type: type,
        initList: initList
    };
}

// ({EXPRPREOP} EXPRVALUE {EXPRPOSTOP})
function parseExprTerm2(parser: ParserState): NodeExprTerm2 | undefined {
    const rangeStart = parser.next();

    const preOps: TokenObject[] = [];
    while (parser.isEnd() === false) {
        const next = parser.next();
        if (next.isReservedToken() === false || next.property.isExprPreOp === false) break;
        preOps.push(parser.next());
        parser.commit(HighlightToken.Operator);
    }

    const exprValue = parseExprValue(parser);
    if (exprValue === ParseFailure.Mismatch) parser.backtrack(rangeStart);
    if (exprValue === ParseFailure.Mismatch || exprValue === ParseFailure.Pending) {
        return undefined;
    }

    const postOps: NodeExprPostOp[] = [];
    while (parser.isEnd() === false) {
        const parsed = parseExprPostOp(parser);
        if (parsed === undefined) break;
        postOps.push(parsed);
    }

    return {
        nodeName: NodeName.ExprTerm,
        nodeRange: {start: rangeStart, end: parser.prev()},
        exprTerm: 2,
        preOps: preOps,
        value: exprValue,
        postOps: postOps
    };
}

// EXPRVALUE     ::= 'void' | CONSTRUCTCALL | FUNCCALL | VARACCESS | CAST | LITERAL | '(' ASSIGN ')' | LAMBDA
function parseExprValue(parser: ParserState): ParsedResult<NodeExprValue> {
    const cast = parseCast(parser);
    if (cast === ParseFailure.Pending) return ParseFailure.Pending;
    if (cast !== ParseFailure.Mismatch) return cast;

    if (parser.next().text === '(') {
        parser.commit(HighlightToken.Operator);

        const assign = expectAssign(parser);
        if (assign === undefined) return ParseFailure.Pending;

        parser.expect(')', HighlightToken.Operator);
        return assign;
    }

    const literal = parseLiteral(parser);
    if (literal !== undefined) return literal;

    const lambda = parseLambda(parser);
    if (lambda === ParseFailure.Pending) return ParseFailure.Pending;
    if (lambda !== ParseFailure.Mismatch) return lambda;

    const funcCall = parseFuncCall(parser);
    if (funcCall !== undefined) return funcCall;

    const constructCall = parseConstructCall(parser);
    if (constructCall !== undefined) return constructCall;

    const varAccess = parseVarAccess(parser);
    if (varAccess !== undefined) return varAccess;

    return ParseFailure.Mismatch;
}

// CONSTRUCTCALL ::= TYPE ARGLIST
function parseConstructCall(parser: ParserState): NodeConstructCall | undefined {
    const rangeStart = parser.next();
    const type = parseType(parser);
    if (type === undefined) return undefined;

    const argList = parseArgList(parser);
    if (argList === undefined) {
        parser.backtrack(rangeStart);
        return undefined;
    }

    return {
        nodeName: NodeName.ConstructCall,
        nodeRange: {start: rangeStart, end: parser.prev()},
        type: type,
        argList: argList
    };
}

// EXPRPREOP     ::= '-' | '+' | '!' | '++' | '--' | '~' | '@'

// EXPRPOSTOP    ::= ('.' (FUNCCALL | IDENTIFIER)) | ('[' [IDENTIFIER ':'] ASSIGN {',' [IDENTIFIER ':' ASSIGN} ']') | ARGLIST | '++' | '--'
function parseExprPostOp(parser: ParserState): NodeExprPostOp | undefined {
    const rangeStart = parser.next();

    const exprPostOp1 = parseExprPostOp1(parser);
    if (exprPostOp1 !== undefined) return exprPostOp1;

    const exprPostOp2 = parseExprPostOp2(parser);
    if (exprPostOp2 !== undefined) return exprPostOp2;

    const argList = parseArgList(parser);
    if (argList !== undefined)
        return {
            nodeName: NodeName.ExprPostOp,
            nodeRange: {start: rangeStart, end: parser.prev()},
            postOp: 3,
            args: argList
        };

    const maybeOperator = parser.next().text;
    if (maybeOperator === '++' || maybeOperator === '--') {
        parser.commit(HighlightToken.Operator);
        return {
            nodeName: NodeName.ExprPostOp,
            nodeRange: {start: rangeStart, end: parser.prev()},
            postOp: 4,
            operator: maybeOperator
        };
    }

    return undefined;
}

// ('.' (FUNCCALL | IDENTIFIER))
function parseExprPostOp1(parser: ParserState): NodeExprPostOp1 | undefined {
    if (parser.next().text !== '.') return undefined;
    const rangeStart = parser.next();
    parser.commit(HighlightToken.Operator);

    const funcCall = parseFuncCall(parser);
    if (funcCall !== undefined)
        return {
            nodeName: NodeName.ExprPostOp,
            nodeRange: {start: rangeStart, end: parser.prev()},
            postOp: 1,
            member: funcCall,
        };

    const identifier = expectIdentifier(parser, HighlightToken.Variable);
    return {
        nodeName: NodeName.ExprPostOp,
        nodeRange: {start: rangeStart, end: parser.prev()},
        postOp: 1,
        member: identifier
    };
}

// ('[' [IDENTIFIER ':'] ASSIGN {',' [IDENTIFIER ':' ASSIGN} ']')
function parseExprPostOp2(parser: ParserState): NodeExprPostOp2 | undefined {
    if (parser.next().text !== '[') return undefined;
    const rangeStart = parser.next();
    parser.commit(HighlightToken.Operator);

    const indexerList: ParsedPostIndexer[] = [];
    while (parser.isEnd() === false) {
        const loopStart = parser.next();
        const identifier = parseIdentifierWithColon(parser);

        const assign = expectAssign(parser);
        if (assign !== undefined) indexerList.push({identifier: identifier, assign: assign});

        if (expectContinuousOrClose(parser, ',', ']', indexerList.length > 0) === BreakOrThrough.Break) break;

        // Cancel infinite loop
        // FIXME: check other places too?
        if (loopStart === parser.next()) break;
    }

    return {
        nodeName: NodeName.ExprPostOp,
        nodeRange: {start: rangeStart, end: parser.prev()},
        postOp: 2,
        indexerList: indexerList
    };
}

// [IDENTIFIER ':']
function parseIdentifierWithColon(parser: ParserState): TokenObject | undefined {
    if (parser.next(0).kind === TokenKind.Identifier && parser.next(1).text === ':') {
        const identifier = parser.next();
        parser.commit(HighlightToken.Parameter);
        parser.commit(HighlightToken.Operator);
        return identifier;
    }
    return undefined;
}

// CAST          ::= 'cast' '<' TYPE '>' '(' ASSIGN ')'
function parseCast(parser: ParserState): ParsedResult<NodeCast> {
    if (parser.next().text !== 'cast') return ParseFailure.Mismatch;
    const rangeStart = parser.next();
    parser.commit(HighlightToken.Keyword);

    if (parser.expect('<', HighlightToken.Operator) === false) return ParseFailure.Pending;

    const type = expectType(parser);
    if (type === undefined) return ParseFailure.Pending;

    if (parser.expect('>', HighlightToken.Operator) === false) return ParseFailure.Pending;
    if (parser.expect('(', HighlightToken.Operator) === false) return ParseFailure.Pending;

    const assign = expectAssign(parser);
    if (assign === undefined) return ParseFailure.Pending;

    parser.expect(')', HighlightToken.Operator);

    return {
        nodeName: NodeName.Cast,
        nodeRange: {start: rangeStart, end: parser.prev()},
        type: type,
        assign: assign
    };
}

// LAMBDA        ::= 'function' '(' [[TYPE TYPEMOD] [IDENTIFIER] {',' [TYPE TYPEMOD] [IDENTIFIER]}] ')' STATBLOCK
const parseLambda = (parser: ParserState): ParsedResult<NodeLambda> => {
    // ラムダ式の判定は、呼び出し末尾の「(」の後に「{」があるかどうかで判定する
    if (canParseLambda(parser) === false) return ParseFailure.Mismatch;

    const rangeStart = parser.next();
    parser.commit(HighlightToken.Builtin);

    parser.expect('(', HighlightToken.Operator);

    const result: Mutable<NodeLambda> = {
        nodeName: NodeName.Lambda,
        nodeRange: {start: rangeStart, end: parser.prev()},
        paramList: [],
        statBlock: undefined
    };

    while (parser.isEnd() === false) {
        if (expectCommaOrParensClose(parser, result.paramList.length > 0) === BreakOrThrough.Break) break;

        if (parser.next(0).kind === TokenKind.Identifier && isCommaOrParensClose(parser.next(1).text)) {
            result.paramList.push({type: undefined, typeMod: undefined, identifier: parser.next()});
            parser.commit(HighlightToken.Parameter);
            continue;
        }

        const type = parseType(parser);
        const typeMod = type !== undefined ? parseTypeMod(parser) : undefined;
        const identifier: TokenObject | undefined = parseIdentifier(parser, HighlightToken.Parameter);
        result.paramList.push({type: type, typeMod: typeMod, identifier: identifier});
    }

    result.statBlock = expectStatBlock(parser);
    return appliedNodeEnd(parser, result);
};

function canParseLambda(parser: ParserState): boolean {
    if (parser.next().text !== 'function') return false;
    if (parser.next(1).text !== '(') return false;
    let i = 2;
    while (parser.isEnd() === false) {
        if (parser.next(i).text === ')') {
            return parser.next(i + 1).text === '{';
        }
        i++;
    }
    return false;
}

// LITERAL       ::= NUMBER | STRING | BITS | 'true' | 'false' | 'null'
function parseLiteral(parser: ParserState): NodeLiteral | undefined {
    const next = parser.next();
    if (next.kind === TokenKind.Number) {
        parser.commit(HighlightToken.Number);
        return {nodeName: NodeName.Literal, nodeRange: {start: next, end: next}, value: next};
    }
    if (next.kind === TokenKind.String) {
        parser.commit(HighlightToken.String);
        return {nodeName: NodeName.Literal, nodeRange: {start: next, end: next}, value: next};
    }
    if (next.text === 'true' || next.text === 'false' || next.text === 'null') {
        parser.commit(HighlightToken.Builtin);
        return {nodeName: NodeName.Literal, nodeRange: {start: next, end: next}, value: next};
    }
    return undefined;
}

// FUNCCALL      ::= SCOPE IDENTIFIER ARGLIST
function parseFuncCall(parser: ParserState): NodeFuncCall | undefined {
    const rangeStart = parser.next();
    const scope = parseScope(parser);

    const identifier = parseIdentifier(parser, HighlightToken.Function);
    if (identifier === undefined) {
        parser.backtrack(rangeStart);
        return undefined;
    }

    const typeTemplates = parseTypeTemplates(parser);

    const argList = parseArgList(parser);
    if (argList === undefined) {
        parser.backtrack(rangeStart);
        return undefined;
    }

    return {
        nodeName: NodeName.FuncCall,
        nodeRange: {start: rangeStart, end: parser.prev()},
        scope: scope,
        identifier: identifier,
		typeTemplates: typeTemplates,
        argList: argList
    };
}

// VARACCESS     ::= SCOPE IDENTIFIER
function parseVarAccess(parser: ParserState): NodeVarAccess | undefined {
    const rangeStart = parser.next();
    const scope = parseScope(parser);

    const next = parser.next();
    if (next.kind !== TokenKind.Identifier) {
        if (scope === undefined) return undefined;
        parser.error("Expected identifier.");
        return {
            nodeName: NodeName.VarAccess,
            nodeRange: {start: rangeStart, end: parser.prev()},
            scope: scope,
            identifier: undefined
        };
    }
    const isBuiltin: boolean = scope === undefined && next.text === 'this';
    parser.commit(isBuiltin ? HighlightToken.Builtin : HighlightToken.Variable);

    return {
        nodeName: NodeName.VarAccess,
        nodeRange: {start: rangeStart, end: parser.prev()},
        scope: scope,
        identifier: next
    };
}

// ARGLIST       ::= '(' [IDENTIFIER ':'] ASSIGN {',' [IDENTIFIER ':'] ASSIGN} ')'
function parseArgList(parser: ParserState): NodeArgList | undefined {
    if (parser.next().text !== '(') return undefined;
    const rangeStart = parser.next();
    parser.commit(HighlightToken.Operator);

    const argList: ParsedArgument[] = [];
    while (parser.isEnd() === false) {
        if (expectCommaOrParensClose(parser, argList.length > 0) === BreakOrThrough.Break) break;

        const identifier = parseIdentifierWithColon(parser);

        const assign = expectAssign(parser);
        if (assign === undefined) break;

        argList.push({identifier: identifier, assign: assign});
    }

    return {
        nodeName: NodeName.ArgList,
        nodeRange: {start: rangeStart, end: parser.prev()},
        argList: argList
    };
}

// ASSIGN        ::= CONDITION [ ASSIGNOP ASSIGN ]
function parseAssign(parser: ParserState): NodeAssign | undefined {
    const rangeStart = parser.next();

    const condition = parseCondition(parser);
    if (condition === undefined) return undefined;

    const operator = parseAssignOp(parser);

    const result: Mutable<NodeAssign> = {
        nodeName: NodeName.Assign,
        nodeRange: {start: rangeStart, end: parser.prev()},
        condition: condition,
        tail: undefined
    };

    if (operator === undefined) return result;

    const assign = parseAssign(parser);
    if (assign === undefined) return result;

    result.tail = {operator: operator, assign: assign};
    result.nodeRange = makeParsedRange(rangeStart, parser.prev());

    return result;
}

function expectAssign(parser: ParserState): NodeAssign | undefined {
    const assign = parseAssign(parser);
    if (assign === undefined) {
        parser.error("Expected assignment.");
    }
    return assign;
}

// CONDITION     ::= EXPR ['?' ASSIGN ':' ASSIGN]
function parseCondition(parser: ParserState): NodeCondition | undefined {
    const rangeStart = parser.next();

    const expr = parseExpr(parser);
    if (expr === undefined) return undefined;

    const result: Mutable<NodeCondition> = {
        nodeName: NodeName.Condition,
        nodeRange: {start: rangeStart, end: rangeStart},
        expr: expr,
        ternary: undefined
    };

    if (parser.next().text === '?') {
        parser.commit(HighlightToken.Operator);

        const trueAssign = expectAssign(parser);
        if (trueAssign === undefined) return result;

        parser.expect(':', HighlightToken.Operator);

        const falseAssign = expectAssign(parser);
        if (falseAssign === undefined) return result;

        result.ternary = {trueAssign: trueAssign, falseAssign: falseAssign};
    }

    result.nodeRange = makeParsedRange(rangeStart, parser.prev());
    return result;
}

// EXPROP        ::= MATHOP | COMPOP | LOGICOP | BITOP
function parseExprOp(parser: ParserState) {
    const next = getNextLinkedGreaterThan(parser);
    if (next.isReservedToken() === false) return undefined;
    if (next.property.isExprOp === false) return parseNotIsOperator(parser);
    parser.commit(next.text === 'is' ? HighlightToken.Builtin : HighlightToken.Operator);
    return next;
}

// '!is' requires special handling.
function parseNotIsOperator(parser: ParserState) {
    if (isTokensLinkedBy(parser.next(), ['!', 'is']) === false) return undefined;

    const location = getLocationBetween(parser.next(0), parser.next(1));
    parser.commit(HighlightToken.Builtin);
    parser.commit(HighlightToken.Builtin);

    return TokenReserved.createVirtual('!is', location);
}

// BITOP         ::= '&' | '|' | '^' | '<<' | '>>' | '>>>'

// MATHOP        ::= '+' | '-' | '*' | '/' | '%' | '**'

// COMPOP        ::= '==' | '!=' | '<' | '<=' | '>' | '>=' | 'is' | '!is'

// LOGICOP       ::= '&&' | '||' | '^^' | 'and' | 'or' | 'xor'

// ASSIGNOP      ::= '=' | '+=' | '-=' | '*=' | '/=' | '|=' | '&=' | '^=' | '%=' | '**=' | '<<=' | '>>=' | '>>>='
function parseAssignOp(parser: ParserState) {
    const next = getNextLinkedGreaterThan(parser);
    if (next.isReservedToken() === false || next.property.isAssignOp === false) return undefined;
    parser.commit(HighlightToken.Operator);
    return next;
}

function getNextLinkedGreaterThan(parser: ParserState) {
    if (parser.next().text !== '>') return parser.next();

    const check = (targets: string[], uniqueTokenText: string) => {
        if (isTokensLinkedBy(parser.next(1), targets) === false) return undefined;
        const location = getLocationBetween(parser.next(0), parser.next(targets.length));
        for (let i = 0; i < targets.length; ++i) parser.commit(HighlightToken.Operator);
        return TokenReserved.createVirtual(uniqueTokenText, location);
    };

    // '>='
    const greaterThanTokenOrEqualToken = check(['='], '>=');
    if (greaterThanTokenOrEqualToken !== undefined) return greaterThanTokenOrEqualToken;

    // '>>>='
    const bitShiftRightArithmeticAssignToken = check(['>', '>', '='], '>>>=');
    if (bitShiftRightArithmeticAssignToken !== undefined) return bitShiftRightArithmeticAssignToken;

    // '>>>'
    const bitShiftRightArithmeticToken = check(['>', '>'], '>>>');
    if (bitShiftRightArithmeticToken !== undefined) return bitShiftRightArithmeticToken;

    // '>>='
    const bitShiftRightAssignToken = check(['>', '='], '>>=');
    if (bitShiftRightAssignToken !== undefined) return bitShiftRightAssignToken;

    // '>>'
    const bitShiftRightToken = check(['>'], '>>');
    if (bitShiftRightToken !== undefined) return bitShiftRightToken;

    return parser.next();
}

export function parseAfterTokenized(tokens: TokenObject[]): NodeScript {
    const parser = new ParserState(tokens);

    const script: NodeScript = [];
    while (parser.isEnd() === false) {
        script.push(...parseScript(parser));
        if (parser.isEnd() === false) {
            parser.error("Unexpected token.");
            parser.step();
        }
    }

    return script;
}
