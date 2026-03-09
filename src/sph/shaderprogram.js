import { createProgram, getUniformLocations } from './glutils.js';

export class ShaderProgram {
    #gl;
    #program;
    #uniforms;
    constructor(gl, vsSource, fsSource, location, stride, uniformBlockNameBinding) {
        this.#gl       = gl;
        this.#program  = createProgram(this.#gl, vsSource, fsSource);
        this.#uniforms = getUniformLocations(this.#gl, this.#program);
        this.location  = location;
        this.stride    = stride;
        
        for (const [name, binding] of uniformBlockNameBinding) {
            const idx = this.#gl.getUniformBlockIndex(this.#program, name);
            this.#gl.uniformBlockBinding(this.#program, idx, binding);
        }
    }

    use() {
        this.#gl.useProgram(this.#program);
    }

    uniform(name) {
        if (name in this.#uniforms)
            return this.#uniforms[name];

        const legacyAlias = {
            u_container_velocity: 'u_container_vel',
            u_container_acceleration: 'u_container_acc',
            u_container_angular_velocity: 'u_container_ang_vel',
            u_container_angular_acceleration: 'u_container_ang_acc',
            u_reverse_impulse: 'u_reverse_impulse_strength',
        };
        const alias = legacyAlias[name];
        if (alias && alias in this.#uniforms)
            return this.#uniforms[alias];

        // debug
        console.error(`Uniform '${name}' does not exist.`);
    }
}
