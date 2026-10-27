import { expect, describe, it } from "bun:test";
import { renderLatex } from "../src/index.ts";

type LatexCase = readonly [source: string, expected: string];

function defineCases(cases: readonly LatexCase[]): void {
	for (const [source, expected] of cases) {
		it(`renders ${JSON.stringify(source)}`, () => {
			expect(renderLatex(source)).toBe(expected);
		});
	}
}

describe("renderLatex", () => {
	describe("Jacobian conjecture session using dollar delimiters", () => {
		defineCases([
			[String.raw`\mathbb{C}^3 \to \mathbb{C}^3`, "ℂ³ → ℂ³"],
			[
				String.raw`\{3x+2y,\; 27x^2-4z-1,\; x(x-1)(x+1)\} \quad\Rightarrow\quad x \in \{0, \pm 1\},`,
				"{3x+2y, 27x²-4z-1, x(x-1)(x+1)} ⇒ x ∈ {0, ± 1},",
			],
			[String.raw`F_1 = -\frac{1}{4x^2}.`, "F₁ = -1/(4x²)."],
			["-2", "-2"],
			["(0,0,-1/4)", "(0,0,-1/4)"],
			["(1,-3/2,13/2)", "(1,-3/2,13/2)"],
			["(1,1,1)", "(1,1,1)"],
			["(2,1,0)", "(2,1,0)"],
			["(-1/4, 0, 0)", "(-1/4, 0, 0)"],
			[String.raw`\{(0,0,-1/4), (1,-3/2,13/2), (-1,3/2,13/2)\}`, "{(0,0,-1/4), (1,-3/2,13/2), (-1,3/2,13/2)}"],
			["(2,1,1)", "(2,1,1)"],
			["(7/3,-2/5,11/7)", "(7/3,-2/5,11/7)"],
			[String.raw`\{y - p(x),\; q(x)\}`, "{y - p(x), q(x)}"],
			[String.raw`\deg q = 3`, "deg q = 3"],
			[String.raw`[\mathbb{C}(x,y,z):\mathbb{C}(F_1,F_2,F_3)] = 3`, "[ℂ(x,y,z):ℂ(F₁,F₂,F₃)] = 3"],
			["u = 1+xy", "u = 1+xy"],
			["G = u^2 z + y^2(4+3xy)", "G = u² z + y²(4+3xy)"],
			["F_1 = uG", "F₁ = uG"],
			["F_2 = y + 3xG", "F₂ = y + 3xG"],
			["x=0", "x = 0"],
			["F_2 = F_3 = 0", "F₂ = F₃ = 0"],
			["xy = -3/2", "xy = -3/2"],
			["x^2 z = 13/2", "x² z = 13/2"],
			[String.raw`\mathbb{C}^*`, "ℂ^*"],
			[String.raw`s \mapsto (s,\, -\tfrac{3}{2s},\, \tfrac{13}{2s^2})`, "s ↦ (s, -3/(2s), 13/(2s²))"],
			["X", "X"],
			[String.raw`p_\pm`, "p_±"],
			["F(-x,-y,z) = (F_1, -F_2, -F_3)", "F(-x,-y,z) = (F₁, -F₂, -F₃)"],
			["p_0", "p₀"],
			[String.raw`s \to \infty`, "s → ∞"],
			["(0,0,0)", "(0,0,0)"],
			[String.raw`\Rightarrow`, "⇒"],
			[String.raw`\ge 2`, "≥ 2"],
			[String.raw`\ge 3`, "≥ 3"],
			["1", "1"],
			[String.raw`\mathrm{diag}(-1/2,1,1)`, "diag(-1/2,1,1)"],
			["4+3xy", "4+3xy"],
		]);
	});

	describe("satellite calculation session using bracket delimiters", () => {
		defineCases([
			[
				String.raw`E \approx \frac{0.1\ \text{lux}}{100\ \text{lm/W}} = 0.001\ \text{W/m}^2`,
				"E ≈ (0.1 lux)/(100 lm/W) = 0.001 W/m²",
			],
			[String.raw`\boxed{1\ \text{milliwatt per square metre}}`, "[1 milliwatt per square metre]"],
			[String.raw`5\ \text{km}^2 = 5{,}000{,}000\ \text{m}^2`, "5 km² = 5,000,000 m²"],
			[
				String.raw`P_{\text{light}} = 0.001 \times 5{,}000{,}000
= \boxed{5{,}000\ \text{W}}`,
				"P_light = 0.001 × 5,000,000 = [5,000 W]",
			],
			[
				String.raw`P_{\text{electric}} = 5\ \text{kW} \times 0.2
= \boxed{1\ \text{kW}}`,
				"P_electric = 5 kW × 0.2 = [1 kW]",
			],
			[String.raw`\pi(2.5\ \text{km})^2 = 19.6\ \text{km}^2`, "π(2.5 km)² = 19.6 km²"],
			[
				String.raw`0.001\ \text{W/m}^2 \times 19.6 \times 10^6\ \text{m}^2
\approx \boxed{20\ \text{kW optical}}`,
				"0.001 W/m² × 19.6 × 10⁶ m² ≈ [20 kW optical]",
			],
			[
				String.raw`1\ \text{kW} \times \frac{1}{3600}\ \text{hour}
= \boxed{0.28\ \text{Wh}}`,
				"1 kW × 1/3600 hour = [0.28 Wh]",
			],
		]);
	});

	describe("Jacobian conjecture sessions using parenthesis and bracket delimiters", () => {
		defineCases([
			[
				String.raw`\det\!\left(\frac{\partial(F_1,F_2,F_3)}{\partial(x,y,z)}\right)=-2.`,
				"det((∂(F₁,F₂,F₃))/(∂(x,y,z))) = -2.",
			],
			[
				String.raw`\begin{aligned}
F(0,0,-\tfrac14)&=(-\tfrac14,0,0),\\
F(1,-\tfrac32,\tfrac{13}2)&=(-\tfrac14,0,0),\\
F(-1,\tfrac32,\tfrac{13}2)&=(-\tfrac14,0,0).
\end{aligned}`,
				"F(0,0,-1/4) = (-1/4,0,0),\nF(1,-3/2,13/2) = (-1/4,0,0),\nF(-1,3/2,13/2) = (-1/4,0,0).",
			],
			["F=(F_1,F_2,F_3)", "F = (F₁,F₂,F₃)"],
			["F", "F"],
			["3", "3"],
		]);
	});

	describe("Jacobian matrix session using dollar delimiters", () => {
		defineCases([
			[
				String.raw`J = \begin{pmatrix}
\frac{\partial f_1}{\partial x} & \frac{\partial f_1}{\partial y} & \frac{\partial f_1}{\partial z} \\
\frac{\partial f_2}{\partial x} & \frac{\partial f_2}{\partial y} & \frac{\partial f_2}{\partial z} \\
\frac{\partial f_3}{\partial x} & \frac{\partial f_3}{\partial y} & \frac{\partial f_3}{\partial z}
\end{pmatrix}`,
				"J = ⎛ (∂ f₁)/(∂ x) │ (∂ f₁)/(∂ y) │ (∂ f₁)/(∂ z) ⎞\n    ⎜ (∂ f₂)/(∂ x) │ (∂ f₂)/(∂ y) │ (∂ f₂)/(∂ z) ⎟\n    ⎝ (∂ f₃)/(∂ x) │ (∂ f₃)/(∂ y) │ (∂ f₃)/(∂ z) ⎠",
			],
			[
				String.raw`\begin{aligned}
f_1 &= (1+xy)^3 z + y^2(1+xy)(4+3xy) \\
f_2 &= y + 3x(1+xy)^2 z + 3xy^2(4+3xy) \\
f_3 &= 2x - 3x^2y - x^3z
\end{aligned}`,
				"f₁ = (1+xy)³ z + y²(1+xy)(4+3xy)\nf₂ = y + 3x(1+xy)² z + 3xy²(4+3xy)\nf₃ = 2x - 3x²y - x³z",
			],
			["x, y, z", "x, y, z"],
			["(x, y, z)", "(x, y, z)"],
			[String.raw`(0,\; 0,\; -\tfrac14)`, "(0, 0, -1/4)"],
			[String.raw`(-\tfrac14,\; 0,\; 0)`, "(-1/4, 0, 0)"],
			[String.raw`(1,\; -\tfrac32,\; \tfrac{13}{2})`, "(1, -3/2, 13/2)"],
			[String.raw`(-1,\; \tfrac32,\; \tfrac{13}{2})`, "(-1, 3/2, 13/2)"],
			[String.raw`(-\frac14, 0, 0)`, "(-1/4, 0, 0)"],
			[String.raw`F: \mathbb{C}^3 \to \mathbb{C}^3`, "F: ℂ³ → ℂ³"],
			[
				String.raw`F(0,0,-\tfrac14) = F(1,-\tfrac32,\tfrac{13}{2}) = F(-1,\tfrac32,\tfrac{13}{2}) = (-\tfrac14, 0, 0)`,
				"F(0,0,-1/4) = F(1,-3/2,13/2) = F(-1,3/2,13/2) = (-1/4, 0, 0)",
			],
			[String.raw`\mathbb{C}^3`, "ℂ³"],
			[
				String.raw`\begin{aligned}
f_1 &= \frac{f_1^{\text{ut}}(u,t)}{x^2}, \quad
f_2 = \frac{f_2^{\text{ut}}(u,t)}{x}, \quad
f_3 = x\,(2 - 3u - t)
\end{aligned}`,
				"f₁ = (f₁ᵘᵗ(u,t))/(x²), f₂ = (f₂ᵘᵗ(u,t))/x, f₃ = x (2 - 3u - t)",
			],
			[String.raw`\det J_F`, "det J_F"],
			[String.raw`(-\tfrac14, 0, 0)`, "(-1/4, 0, 0)"],
			["u = xy", "u = xy"],
			["t = x^2z", "t = x²z"],
			[String.raw`x \neq 0`, "x ≠ 0"],
			[String.raw`f_1^{\text{ut}}, f_2^{\text{ut}}`, "f₁ᵘᵗ, f₂ᵘᵗ"],
			["u,t", "u,t"],
			["x", "x"],
			["x, x^2", "x, x²"],
			[String.raw`\mathbb{C}^n \to \mathbb{C}^n`, "ℂⁿ → ℂⁿ"],
			[String.raw`n \geq 2`, "n ≥ 2"],
			[String.raw`\mathbb{P}^3`, "ℙ³"],
		]);
	});

	describe("extended formulas from a renderer stress-test session", () => {
		defineCases([
			[String.raw`e^{i\pi}+1=0`, "e^(iπ)+1 = 0"],
			[
				String.raw`\boxed{
\mathcal{Z}(\beta)
=
\int_{\mathcal M}
\exp\!\left(
-\beta\left[
\frac12 g^{ij}(x)\,\partial_i\phi\,\partial_j\phi
+V(\phi)
\right]\right)
\mathcal D\phi
}`,
				"[Z(β) = ∫_M exp( -β[ 1/2 gⁱʲ(x) ∂ᵢϕ ∂ⱼϕ +V(ϕ) ]) Dϕ]",
			],
			[
				String.raw`\begin{aligned}
\nabla_\mu T^{\mu\nu}
&=
\frac{1}{\sqrt{-g}}
\partial_\mu\!\left(\sqrt{-g}\,T^{\mu\nu}\right)
+\Gamma^\nu_{\mu\lambda}T^{\mu\lambda}
=0, \\[4pt]
R_{\mu\nu}-\frac12 Rg_{\mu\nu}+\Lambda g_{\mu\nu}
&=
\frac{8\pi G}{c^4}T_{\mu\nu}.
\end{aligned}`,
				"∇_μ T^(μν) = 1/(√(-g)) ∂_μ(√(-g) T^(μν)) +Γ^ν_(μλ)T^(μλ) = 0,\nR_(μν)-1/2 Rg_(μν)+Λ g_(μν) = (8π G)/(c⁴)T_(μν).",
			],
			[
				String.raw`f(z)
=
\frac{1}{2\pi i}
\oint_{\gamma}
\frac{f(\zeta)}{\zeta-z}\,d\zeta,
\qquad
\det\!\begin{pmatrix}
\lambda-a & -b & 0\\
-c & \lambda-d & -e\\
0 & -f & \lambda-g
\end{pmatrix}
=0.`,
				[
					"f(z) = 1/(2π i) ∮_γ (f(ζ))/(ζ-z) dζ, det⎛ λ-a │ -b  │ 0   ⎞ = 0.",
					`${" ".repeat(40)}⎜ -c  │ λ-d │ -e  ⎟`,
					`${" ".repeat(40)}⎝ 0   │ -f  │ λ-g ⎠`,
				].join("\n"),
			],
			[
				String.raw`\Psi(x,t)=
\sum_{n=1}^{\infty}
\underbrace{
c_n
\sqrt{\frac{2}{L}}
\sin\!\left(\frac{n\pi x}{L}\right)
}_{\text{spatial eigenmode}}
\exp\!\left(-\frac{i\hbar n^2\pi^2}{2mL^2}t\right),
\qquad
|\Psi(x,t)|^2
=
\begin{cases}
\Psi^\ast\Psi, & 0<x<L,\\
0, & \text{otherwise}.
\end{cases}`,
				"Ψ(x,t) = ∑ₙ₌₁^∞ cₙ √(2/L) sin((nπ x)/L)_(spatial eigenmode) exp(-(iℏ n²π²)/(2mL²)t), |Ψ(x,t)|² = ⎧ Ψ^∗Ψ if 0 < x < L,\n⎩ 0 otherwise.",
			],
			[String.raw`x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}`, "x = (-b±√(b²-4ac))/(2a)"],
			[String.raw`\int_0^\infty e^{-x^2}\,dx=\frac{\sqrt{\pi}}{2}`, "∫₀^∞ e^(-x²) dx = (√π)/2"],
			[String.raw`e^{i\theta}=\cos\theta+i\sin\theta`, "e^(iθ) = cos θ+i sin θ"],
			[String.raw`\sum_{n=1}^{\infty}\frac{1}{n^2}=\frac{\pi^2}{6}`, "∑ₙ₌₁^∞1/(n²) = π²/6"],
			[String.raw`\lim_{x\to 0}\frac{\sin x}{x}=1`, "lim[x→0] (sin x)/x = 1"],
			[
				String.raw`\lim_{n\to\infty}
\left(1+\frac{1}{n}\right)^n=e`,
				"lim[n→∞] (1+1/n)ⁿ = e",
			],
			[
				String.raw`\int_0^1 \frac{x^2}{1+x^3}\,dx
=\frac{1}{3}\ln 2`,
				"∫₀¹ x²/(1+x³) dx = 1/3 ln 2",
			],
			[
				String.raw`\sum_{k=1}^{n}\frac{k}{k+1}
=n+1-H_{n+1}`,
				"∑ₖ₌₁ⁿk/(k+1) = n+1-Hₙ₊₁",
			],
			[
				String.raw`\frac{
  \displaystyle \frac{x^2+1}{x-1}
  -
  \displaystyle \frac{2x}{x+1}
}{
  \displaystyle \frac{x}{x^2-1}
}`,
				"((x²+1)/(x-1) - 2x/(x+1))/(x/(x²-1))",
			],
			[
				String.raw`\lim_{x\to 0}
\frac{
  \displaystyle \frac{\sin x}{x}-1
}{
  \displaystyle \frac{e^x-1}{x}-1
}
=0`,
				"lim[x→0] ((sin x)/x-1)/((eˣ-1)/x-1) = 0",
			],
			[
				String.raw`\frac{
  1+\displaystyle\frac{1}{1+\frac{1}{x}}
}{
  1-\displaystyle\frac{1}{1-\frac{1}{x}}
}`,
				"(1+1/(1+1/x))/(1-1/(1-1/x))",
			],
			[
				String.raw`\sum_{n=1}^{\infty}
\frac{
  \displaystyle \frac{1}{n}-\frac{1}{n+1}
}{
  \displaystyle 1+\frac{1}{n^2}
}`,
				"∑ₙ₌₁^∞ (1/n-1/(n+1))/(1+1/(n²))",
			],
		]);
	});

	it("renders common symbols, roots, sums, and integrals", () => {
		expect(renderLatex(String.raw`\sum_{i=0}^n \alpha_i + \int_0^\infty e^{-x^2}\,dx = \sqrt{\pi}`)).toBe("∑ᵢ₌₀ⁿ αᵢ + ∫₀^∞ e^(-x²) dx = √π");
	});

	it("renders common accents and binomial notation", () => {
		expect(renderLatex(String.raw`\binom{n}{k}+\vec{x}+\hat{y}+\overline{AB}`)).toBe("(n choose k)+x⃗+ŷ+overline(AB)");
	});

	it("renders extended symbols and negated relations", () => {
		expect(renderLatex(String.raw`\epsilon+\varepsilon+\varsigma+\varkappa+\oplus+\otimes+\therefore+\because`)).toBe("ϵ+ε+ς+ϰ+⊕+⊗+∴+∵");
		expect(renderLatex(String.raw`A\not\subseteq B,\quad x\not\in X`)).toBe("A ⊈ B, x ∉ X");
	});

	it("renders relational algebra join operators", () => {
		expect(renderLatex(String.raw`R\bowtie S,\quad R\Join S`)).toBe("R ⋈ S, R ⋈ S");
		expect(renderLatex(String.raw`R\ltimes S,\quad R\rtimes S`)).toBe("R ⋉ S, R ⋊ S");
		expect(renderLatex(String.raw`R\leftouterjoin S,\quad R\rightouterjoin S,\quad R\fullouterjoin S`)).toBe("R ⟕ S, R ⟖ S, R ⟗ S");
	});

	it("renders delimiter commands and invisible delimiters", () => {
		expect(renderLatex(String.raw`\lvert{x}\rvert+\lVert{v}\rVert+\left.\frac{dy}{dx}\right|_{x=0}`)).toBe("|x|+‖v‖+dy/(dx)|ₓ₌₀");
		expect(renderLatex(String.raw`\left\lbrace x \middle| x>0 \right\rbrace`)).toBe("{ x | x > 0 }");
	});

	it("renders named, modular, overlaid, and underlaid operators", () => {
		expect(renderLatex(String.raw`\operatorname*{arg\,max}_{x\in X} f(x)`)).toBe("arg max[x∈X] f(x)");
		expect(renderLatex(String.raw`a\bmod n,\quad a\equiv b\pmod n`)).toBe("a mod n, a ≡ b (mod n)");
		expect(renderLatex(String.raw`\overset{!}{=}+\underset{n}{x}+\stackrel{def}{=}`)).toBe("=^!+xₙ+=ᵈᵉᶠ");
	});

	it("renders indexed roots and additional accents and wrappers", () => {
		expect(renderLatex(String.raw`\sqrt[2]{x}+\sqrt[3]{x}+\sqrt[4]{x}+\sqrt[n]{x}+\sqrt[k]{x+1}`)).toBe("√x+∛x+∜x+ⁿ√x+ᵏ√(x+1)");
		expect(renderLatex(String.raw`\acute{x}+\grave{y}+\widehat{xyz}+\overrightarrow{AB}`)).toBe("x́+ỳ+widehat(xyz)+overrightarrow(AB)");
		expect(renderLatex(String.raw`\textnormal{hello}+\mbox{world}+\boldsymbol{x}`)).toBe("hello+world+x");
	});

	it("renders additional display environments", () => {
		expect(renderLatex(String.raw`\begin{equation}\begin{split}a&=b\\&=c\end{split}\end{equation}`)).toBe("a = b\n= c");
		expect(renderLatex(String.raw`\begin{alignedat}{2}a&=b&\quad c&=d\\e&=f&g&=h\end{alignedat}`)).toBe("a = b c = d\ne = f g = h");
	});

	it("uses natural case conditions and aligns matrix columns", () => {
		expect(renderLatex(String.raw`\begin{cases}a & x<0 \\ b & \text{if }x=0 \\ c & \text{otherwise}\end{cases}`)).toBe("⎧ a if x < 0\n⎨ b if x = 0\n⎩ c otherwise");
		expect(renderLatex(String.raw`\begin{pmatrix}1&200\\3000&4\end{pmatrix}`)).toBe("⎛ 1    │ 200 ⎞\n⎝ 3000 │ 4   ⎠");
	});

	it("composes matrices with fractions and adjacent matrices", () => {
		expect(renderLatex(
				String.raw`R\left(\frac{\pi}{4}\right)
=
\begin{pmatrix}
\frac{\sqrt{2}}{2} & -\frac{\sqrt{2}}{2}\\
\frac{\sqrt{2}}{2} & \frac{\sqrt{2}}{2}
\end{pmatrix}.`,
				{ display: true },
			)).toBe("   π\nR( ─ ) = ⎛ (√2)/2 │ -(√2)/2 ⎞\n   4     ⎝ (√2)/2 │ (√2)/2  ⎠.");
		expect(renderLatex(
				String.raw`\mathbf w
=
R\left(\frac{\pi}{4}\right)
\begin{pmatrix}1\\0\end{pmatrix}
=
\begin{pmatrix}\frac{\sqrt{2}}{2}\\\frac{\sqrt{2}}{2}\end{pmatrix}.`,
				{ display: true },
			)).toBe("       π\nw = R( ─ ) ⎛ 1 ⎞ = ⎛ (√2)/2 ⎞\n       4   ⎝ 0 ⎠   ⎝ (√2)/2 ⎠.");
		expect(renderLatex(
				String.raw`A\mathbf e_1=\begin{pmatrix}\pi\\0\end{pmatrix},\qquad A\mathbf e_2=\begin{pmatrix}0\\\frac{1}{\pi}\end{pmatrix}.`,
				{ display: true },
			)).toBe("Ae₁ = ⎛ π ⎞, Ae₂ = ⎛ 0   ⎞\n      ⎝ 0 ⎠        ⎝ 1/π ⎠.");
		expect(renderLatex(String.raw`\sum_{i=0}^n x_i=\begin{pmatrix}a&b\\c&d\end{pmatrix}.`, { display: true })).toBe(" n\n ∑  xᵢ = ⎛ a │ b ⎞\ni=0      ⎝ c │ d ⎠.");
	});

	it("normalizes relation, multiplication, and named-operator spacing", () => {
		for (const source of ["x=y", "x =y", "x=\ny", "x\n=\ny"]) {
			expect(renderLatex(source)).toBe("x = y");
		}
		expect(renderLatex("x_{i=0}")).toBe("xᵢ₌₀");
		expect(renderLatex(String.raw`x\neq0`)).toBe("x ≠ 0");
		expect(renderLatex(String.raw`A\to B`)).toBe("A → B");
		expect(renderLatex(String.raw`\pi\cdot\frac{1}{\pi}`)).toBe("π · 1/π");
		expect(renderLatex(String.raw`\sin\theta`)).toBe("sin θ");
		expect(renderLatex(String.raw`\sin^2 x`)).toBe("sin² x");
		expect(renderLatex(String.raw`-\sin\theta`)).toBe("-sin θ");
		expect(renderLatex(String.raw`i\sin\theta`)).toBe("i sin θ");
		expect(renderLatex(String.raw`\det(A)`)).toBe("det(A)");
	});

	it("treats a backslash followed by a line ending as control space", () => {
		const source = String.raw`\boxed{
(1,1,1),\ (1,1,2),\ (1,2,5),\ (1,5,13),\ (2,5,29),\
(1,13,34),\ (1,34,89)
}.`;
		expect(renderLatex(source, { display: true })).toBe("[(1,1,1), (1,1,2), (1,2,5), (1,5,13), (2,5,29), (1,13,34), (1,34,89)].");
		expect(renderLatex("a\\\r\nb")).toBe("a b");
	});

	it("stacks operator limits in display mode", () => {
		expect(renderLatex(String.raw`\sum_{i=0}^n x_i`, { display: true })).toBe(" n\n ∑  xᵢ\ni=0");
		expect(renderLatex(String.raw`\min_{x\in X} f(x)`, { display: true })).toBe("min f(x)\nx∈X");
		expect(renderLatex(String.raw`\operatorname*{arg\,max}_{x\in X} f(x)`, {
				display: true,
			})).toBe("arg max f(x)\n  x∈X");
		expect(renderLatex(String.raw`\int\nolimits_0^1 f(x)\,dx`, { display: true })).toBe("∫₀¹ f(x) dx");
		expect(renderLatex(String.raw`\int\limits_0^1 f(x)\,dx`, { display: true })).toBe("1\n∫ f(x) dx\n0");
	});

	it("uses the middle brace for intermediate case rows", () => {
		expect(renderLatex(String.raw`\begin{cases}a & x<0 \\ b & x=0 \\ c & x>0\end{cases}`)).toBe("⎧ a if x < 0\n⎨ b if x = 0\n⎩ c if x > 0");
	});

	it("stacks fractions in display mode", () => {
		expect(renderLatex(String.raw`x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}`, {
				display: true,
			})).toBe("    -b±√(b²-4ac)\nx = ────────────\n         2a");
		expect(renderLatex(String.raw`\frac{x^2+1}{x-1}`, { display: true })).toBe("x²+1\n────\nx-1");
		expect(renderLatex("\\frac{1}\n{2}", { display: true })).toBe("1\n─\n2");
	});

	it("keeps nested display fractions linear", () => {
		const cases: Array<[string, string]> = [
			[
				String.raw`\frac{\frac{x^2+1}{x-1}-\frac{2x}{x+1}}{\frac{x}{x^2-1}}`,
				"(x²+1)/(x-1)-2x/(x+1)\n─────────────────────\n      x/(x²-1)",
			],
			[
				String.raw`\lim_{x\to 0}\frac{\frac{\sin x}{x}-1}{\frac{e^x-1}{x}-1}=0`,
				"     (sin x)/x-1\nlim  ─────────── = 0\nx→0  (eˣ-1)/x-1",
			],
			[
				String.raw`\frac{1+\frac{1}{1+\frac{1}{x}}}{1-\frac{1}{1-\frac{1}{x}}}`,
				"1+1/(1+1/x)\n───────────\n1-1/(1-1/x)",
			],
		];
		for (const [source, expected] of cases) {
			expect(renderLatex(source, { display: true })).toBe(expected);
		}
	});

	it("keeps fractions linear in scripts and text-style fractions", () => {
		expect(renderLatex(String.raw`e^{\frac{1}{2}}`, { display: true })).toBe("e^(1/2)");
		expect(renderLatex(String.raw`\tfrac{1}{2}`, { display: true })).toBe("1/2");
	});

	it("returns undefined for unsupported commands", () => {
		expect(renderLatex(String.raw`x + \unknown{y}`)).toBe(undefined);
	});

	it("returns undefined for malformed groups and environments", () => {
		const malformed = [String.raw`\frac{1}{x`, "x}", String.raw`\begin{matrix}1 & 2`, "x\\"];
		for (const source of malformed) {
			expect(renderLatex(source)).toBe(undefined);
		}
	});

	it("returns undefined for pathologically deep brace nesting instead of overflowing the stack", () => {
		// 8_000 exceeds the parser's depth cap (256) and used to overflow the JS
		// stack before the cap existed; the documented contract is undefined.
		const depth = 8_000;
		expect(renderLatex("{".repeat(depth) + "x" + "}".repeat(depth))).toBe(undefined);
	});

	it("returns undefined for pathologically deep command-argument nesting instead of overflowing the stack", () => {
		// The \frac chain recurses through parseRequiredArgumentValue -> parseCommand
		// (not parseSequence), so it needs its own depth budget.
		const depth = 8_000;
		expect(renderLatex("\\frac".repeat(depth) + "x" + "}".repeat(depth))).toBe(undefined);
	});

	it("renders brace nesting below the depth cap", () => {
		const depth = 100;
		expect(renderLatex("{".repeat(depth) + "x" + "}".repeat(depth))).toBe("x");
	});
});
