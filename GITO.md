# GITO.md — contrato de versionamento e ficha técnica

> Instrução para o Claude (e para quem mais mexer neste repositório).
> O **Gito** lê o `gito.json` desta aplicação para montar o painel: a versão publicada na `main`, a versão de cada branch, o histórico, a ficha técnica e as issues.
> Se o `gito.json` estiver desatualizado, o painel mostra informação errada para a equipe inteira.

## Regra de ouro

**Toda alteração que muda o comportamento da aplicação atualiza o `gito.json` no mesmo trabalho.** Isso vale para funcionalidade, correção, mudança de banco, de hospedagem ou de integração. Não deixe para "depois do commit".

## Onde fica

- **Uma aplicação por repositório:** `gito.json` e `GITO.md` ficam na **raiz** do repositório.
- **Várias aplicações no mesmo repositório:** um `gito.json` na **pasta de cada aplicação** (por exemplo, `wcm/widget/minhaWidget/gito.json`). O Gito procura até 3 níveis abaixo da raiz.
- **Issues:** ficam em `.gito/issues/` e as evidências em `.gito/evidencias/<ID>/`, ao lado do `gito.json` da aplicação.

## Quando mudar a versão (SemVer: `MAIOR.MENOR.CORREÇÃO`)

| Mudança | Exemplo | O que sobe |
|---|---|---|
| Quebra compatibilidade ou redesenho grande | troca de banco, API com contrato novo, tela refeita | **MAIOR** (`1.4.2` → `2.0.0`) |
| Funcionalidade nova, compatível | novo relatório, novo campo, nova tela | **MENOR** (`1.4.2` → `1.5.0`) |
| Correção sem funcionalidade nova | bug, ajuste de texto, desempenho | **CORREÇÃO** (`1.4.2` → `1.4.3`) |
| Só documentação, comentários ou testes | README, teste novo | **nada**: a versão fica, mas a ficha pode mudar |

## Versão por branch

O painel mostra a versão de **cada branch**. Para as versões não se confundirem:

- **Na `main`** (ou `master`): só versão final, **sem sufixo** (`1.5.0`). É a "última versão compilada", a que está (ou vai) para produção.
- **Em qualquer outra branch:** a versão é a **próxima versão planejada** seguida do nome da branch e de um contador:

  ```
  1.5.0-relatorio-vendas.1   primeiro trabalho na branch relatorio-vendas
  1.5.0-relatorio-vendas.2   segundo
  ```

  O nome da branch vai em minúsculas, com `/`, espaço e acentos trocados por `-` (a branch `feature/Relatório Vendas` vira `feature-relatorio-vendas`).
- **Antes de juntar na `main`** (abrir o Merge Request ou fazer o merge), **finalize**:
  1. Tire o sufixo (`1.5.0-relatorio-vendas.3` vira `1.5.0`).
  2. Some 1 em `compilacao.numero`.
  3. Crie a entrada final no `historico`.

  O Gito avisa quando a `main` está com versão de branch.
- **Se a versão planejada já foi usada na `main` por outra branch** (outra pessoa publicou `1.5.0` antes), suba para a próxima livre (`1.6.0`) ao atualizar a sua branch.

## O que atualizar a cada mudança de versão

1. **`versao`:** a nova versão, seguindo as regras acima.
2. **`atualizadoEm`:** a data de hoje, no formato `AAAA-MM-DD`.
3. **`compilacao.numero`:** +1. Ele nunca volta, mesmo entre branches. `compilacao.data` recebe a data de hoje. Se a aplicação gera artefato (`.war`, `.zip`, instalador), `compilacao.artefato` recebe o nome dele.
4. **`historico`:** uma entrada nova **no topo** da lista, e as antigas nunca são apagadas nem reescritas. Os campos:
   - **`versao`, `data`, `branch`:** a versão, a data e a branch do trabalho.
   - **`tipo`:** `funcionalidade`, `correcao`, `melhoria`, `seguranca`, `infraestrutura` ou `quebra`.
   - **`resumo`:** uma frase que a equipe entenda sem abrir o código.
   - **`itens`:** o que mudou, um item por linha, em linguagem de gente.
   - **`issues`:** os IDs resolvidos ou tocados (`["GITO-0003"]`), se houver.
5. **`ficha`:** se a mudança mexeu em escopo, stack, arquitetura, hospedagem, banco, integração ou links, atualize a seção correspondente **no mesmo trabalho**.

## A ficha técnica (`ficha`)

É o que responde "o que é, onde roda, onde guarda os dados e como eu acesso". Mantenha **verdadeira**:

- **`escopo`:** o objetivo, o que a aplicação **faz** (`inclui`) e o que **não faz** (`naoInclui`). O "não faz" evita pedido errado.
- **`stack`:** linguagens, plataformas e bibliotecas relevantes, com versão quando importar.
- **`arquitetura.diagramas`:** cada diagrama tem `titulo` e **um** destes:
  - `arquivo`: caminho **relativo à pasta do `gito.json`** para `.svg`, `.png`, `.jpg` ou `.webp` (prefira `docs/`). O Gito mostra a imagem.
  - `mermaid`: o código Mermaid do diagrama. O Gito mostra o código; se quiser a imagem, exporte o SVG para `docs/` e use `arquivo`.
  - `link`: endereço externo (draw.io, Figma, Confluence).
- **`hospedagem`:** cada ambiente (`Produção`, `Homologação`...) com `onde` (servidor, plataforma), `url` de acesso e `verificar: true` para o Gito conferir se está no ar.
- **`bancoDeDados`:** para cada banco, `tipo` (SQL Server, Oracle...), `servidor`, `porta`, `base`, `acesso` (link do console ou da ferramenta, se houver) e `observacao`. Com `servidor` e `porta`, o Gito testa a conexão TCP. Se a aplicação não tem banco, deixe a lista vazia e explique em `arquitetura.resumo` onde guarda os dados.
- **`integracoes`:** outros sistemas com que conversa (ERP, APIs, datasets), com `url` quando existir.
- **`links`:** repositório, documentação, painel de monitoramento, chamado de homologação.
- **`contatos`:** papel e nome (responsável técnico, dono do negócio). Não coloque telefone nem dados pessoais além do nome.

## Segurança: o que NUNCA entra no `gito.json`

Este arquivo é versionado e lido pela equipe inteira. **Nunca** coloque:

- **Credenciais:** senha, token, chave de API, *connection string* com usuário e senha, certificado.
- **Dados pessoais** de clientes ou colaboradores (CPF, salário, dados de saúde, dados bancários), seguindo a LGPD.

Informe **onde** está o recurso (servidor, porta, link), nunca **como entrar**. Se precisar dizer como obter o acesso, escreva "solicitar acesso via chamado no GLPI".

## Issues (`.gito/issues/`)

As issues são criadas e controladas pela tela do Gito. O Claude pode ler e atualizar, com estas regras:

- **Ao trabalhar numa issue:** mude `status` para `em-andamento` e acrescente um comentário dizendo o que vai fazer.
- **Ao terminar a correção ou melhoria:** mude `status` para `em-revisao` (**não** para `concluida`: quem fecha é uma pessoa, depois de conferir) e acrescente um comentário com o que mudou e em qual versão. Coloque o ID da issue em `historico[].issues`.
- **Registro:** toda mudança de campo entra em `historico` da issue (`quando`, `autor`, `mudanca`). Nunca apague comentários, evidências nem issues.
- **Autor:** o nome configurado no git (`git config user.name`), seguido de `(via Claude)`.

## Conflito no `gito.json` ao juntar branches

- **`versao`:** fica a **maior** versão final, sem sufixo, se o destino for a `main`.
- **`compilacao.numero`:** fica o **maior**, somado de 1.
- **`historico`:** a **união** das entradas dos dois lados, sem duplicar, ordenada da mais nova para a mais antiga.
- **`ficha`:** junte as duas visões; em caso de dúvida, pergunte a quem está pedindo o trabalho.

## Antes de terminar qualquer trabalho, confira

- [ ] O `gito.json` é um JSON válido (confira com um parser antes de terminar).
- [ ] A `versao` segue a regra da branch atual (sem sufixo na `main`, com sufixo nas outras).
- [ ] `atualizadoEm` e `compilacao` foram atualizados, se a versão mudou.
- [ ] Há uma entrada nova no topo do `historico` para a versão nova.
- [ ] A `ficha` continua verdadeira depois da mudança.
- [ ] Nenhuma credencial nem dado pessoal entrou no arquivo.

## Formato do `gito.json`

```json
{
  "$gito": 1,
  "aplicacao": {
    "nome": "Nome legível",
    "codigo": "SIGLA",
    "descricao": "Uma frase: o que é e para quem é.",
    "tipo": "Widget Fluig | Formulário Fluig | Aplicação web | Aplicação local | API | Dataset",
    "situacao": "em desenvolvimento | em homologação | em produção | descontinuada",
    "responsavel": "Nome",
    "equipe": "Área / equipe"
  },
  "versao": "1.0.0",
  "atualizadoEm": "AAAA-MM-DD",
  "compilacao": { "numero": 1, "data": "AAAA-MM-DD", "artefato": "" },
  "historico": [
    {
      "versao": "1.0.0", "data": "AAAA-MM-DD", "branch": "main", "tipo": "funcionalidade",
      "resumo": "Primeira versão.", "itens": ["..."], "issues": []
    }
  ],
  "ficha": {
    "escopo": { "objetivo": "", "inclui": [], "naoInclui": [] },
    "stack": [],
    "arquitetura": { "resumo": "", "diagramas": [] },
    "hospedagem": [ { "ambiente": "Produção", "onde": "", "url": "", "verificar": true } ],
    "bancoDeDados": [ { "nome": "", "tipo": "", "servidor": "", "porta": 1433, "base": "", "acesso": "", "observacao": "" } ],
    "integracoes": [ { "nome": "", "descricao": "", "url": "" } ],
    "links": [ { "titulo": "Repositório", "url": "" } ],
    "contatos": [ { "papel": "Responsável técnico", "nome": "" } ]
  }
}
```

`aplicacao.codigo` é a sigla das issues (`CODIGO-0001`): curta, em maiúsculas e sem espaço. Não a troque depois de criar issues.
