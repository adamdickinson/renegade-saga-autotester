import fs from "fs"
import { parse } from "acorn"
import { recursive } from "acorn/dist/walk"
import flatten from "lodash/flatten"
import uniq from "lodash/uniq"
import get from "lodash/get"
import { join, basename } from "path"



const filePath = join(process.cwd(), process.argv[2])
const fileName = basename(filePath).slice(0, -3)



const upperFirst = string => string.charAt(0).toUpperCase() + string.substr(1)



const render = (node, samplify=false) => {
  const rerender = node => render(node, samplify)
  switch(node.type) {

    case "ArrayExpression":
      return `[${node.elements.map(rerender).join(", ")}]`

    case "CallExpression":
      return `${render(node.callee)}(${node.arguments.map((e, i) => i ? rerender(e) : render(e)).join(", ")})`

    case "Literal":
      return node.raw

    case "Identifier":
      return samplify ? `sample${upperFirst(node.name)}` : node.name

    case "MemberExpression":
      return samplify ? `sample${upperFirst(node.object.name)}.${node.property.name}` : `${node.object.name}.${node.property.name}`

    case "TemplateElement":
      return node.value.raw

    case "TemplateLiteral":
      const expressions = node.expressions.map(expression => ({ render: "${" + rerender(expression) + "}", start: expression.start }))
      const quasis = node.quasis.map(quasi => ({ render: rerender(quasi), start: quasi.start }))
      const parts = [...expressions, ...quasis].sort((a, b) => a.start - b.start)
      return '"' + parts.map(part => part.render).join("") + '"'

  }
}



const samplifyParam = param => {
  let sampleParam
  switch(param.type) {
    case "ObjectPattern":
      sampleParam = []
      param.properties.forEach(property => {
        sampleParam.push(`${property.key.name}: sample${upperFirst(property.value.name)}`)
      })
      return `{ ${sampleParam.join(", ")} }`
  }
}



const code = fs.readFileSync("/data/marshere-management-system/src/sagas/client.js")
const root = parse(code, { sourceType: "module", ecmaVersion: 9 })
const state = { sagas: [], selects: [] }
const tree = recursive(
  root, 
  state,
  {
    Program: (node, state, c) => {
      node.body.forEach(child => c(child, state))
    },

    BlockStatement: (node, state, c) => {
      for( let child of node.body ) {
        c(child, state)
        if( state.path.returned ) state.path = state.paths.find(p => !p.returned)
        if( !state.path ) return
      }
    },

    ReturnStatement: (node, { path }) => {
      path.returned = true
    },

    ExpressionStatement: (node, state, c) => c(node.expression, state),

    IfStatement: (node, { path, paths }, c) => {
      const altPath = JSON.parse(JSON.stringify(path))
      altPath.variation += "fail to "
      c(node.consequent, { path, paths })
      if(node.alternate) {
        paths.push(altPath)
        c(node.alternate, { path: altPath, paths })
      }
    },

    TryStatement: (node, { path, paths }, c) => {
      const altPath = JSON.parse(JSON.stringify(path))
      altPath.variation += "fail to "
      c(node.block, { path, paths })
      if(node.handler) {
        paths.push(altPath)
        c(node.handler, { path: altPath, paths, fail: true })
      }
    },

    YieldExpression: (node, { path, paths, fail=false }, c) => {
      path.assertions.push({ step: fail ? "throw": "next", content: render(node.argument, true) })
    },

    ExportNamedDeclaration: (node, { sagas, selects }, c) => {
      const path = { variation: "", assertions: [] }
      const paths = [path]

      if( node.declaration.type === "FunctionDeclaration" ) {
        sagas.push({
          name:   node.declaration.id.name,
          params: node.declaration.params.map(samplifyParam),
          paths
        })

      } else if( node.declaration.type === "VariableDeclaration" ) {
        selects.push({
          name:  node.declaration.declarations[0].id.name,
          paths
        })
      }

      const subState = { path, paths }
      c(node.declaration, subState)
    },

    FunctionDeclaration: (node, state, c) => {
      c(node.body, state)
    },

    VariableDeclaration: (node, state, c) => {
      node.declarations.forEach(child => c(child, state))
    },

    VariableDeclarator: () => {}
  }
)


const renderSagaTest = ({ variation, name, params, assertions }) => {
  const header = `  it("should ${variation}${name}", () => {\n    const saga = sagas.${name}(${params})`

  const content = assertions.map(assertion => 
    `    expect(saga.${assertion.step}().value)\n      .toEqual(${assertion.content})`) 

  const footer = `    expect(saga.next().done)\n      .toBe(true)\n  })`
  return [header, ...content, footer].join("\n\n")
}



const renderSagaTests = saga => {
  return saga.paths.map(path => renderSagaTest({ ...saga, ...path }))
}



const renderSagaTestFile = sagas => {
  const tests = flatten(state.sagas.map(renderSagaTests)).join("\n\n\n\n")
  const actions = uniq(tests.match(/[a-z]+(?=Actions)/g))
    .map(action => `import * as ${action}Actions from "../actions/${action}"`)

  const helpers = uniq(tests.match(/[a-z]+(?=Helpers)/g))
    .map(helper => `import * as ${helper}Helpers from "../helpers/${helper}"`)

  const samples = uniq(tests.match(/sample[a-zA-Z]+/g)).sort()
  const sampleNameFill = Math.max(...samples.map(sample => sample.length))
  const sampleConsts = samples.map(sample => `  const ${sample.padEnd(sampleNameFill, " ")} = "Sample"`) 

  const imports = `import * as sagas from "./${fileName}"\n` + [...actions, ...helpers].sort().join("\n")
  const header = `describe("${fileName} sagas", () => {`

  const footer = "})"

  return imports + "\n\n\n\n" + header + "\n\n" + sampleConsts.join("\n") + "\n\n\n\n" + tests + "\n\n" + footer
}



fs.writeFileSync(filePath.replace(/\.js$/, ".test.js"), renderSagaTestFile(state.sagas))
